const { getDb } = require('../db/init');

// 内存中的密钥池状态
let keys = [];
let concurrencyMap = new Map(); // keyId -> current concurrency count
let conversationKeyMap = new Map(); // conversationId -> keyId (对话绑定密钥)
let initialized = false;
let dailyResetTimer = null;

function loadKeys() {
  const db = getDb();
  keys = db.prepare('SELECT * FROM api_keys WHERE enabled = 1 ORDER BY priority DESC, id ASC').all();
  // 初始化并发计数（保留已有的计数）
  const newMap = new Map();
  for (const k of keys) {
    newMap.set(k.id, concurrencyMap.get(k.id) || 0);
  }
  concurrencyMap = newMap;
  console.log(`[KeyPool] Loaded ${keys.length} keys`);
}

function init() {
  if (initialized) return;
  loadKeys();
  initialized = true;
  scheduleDailyReset();
  console.log('[KeyPool] Initialized');
}

function reload() {
  loadKeys();
}

/**
 * 获取密钥，支持对话亲和（同一对话固定用同一个 key，利用中转站缓存）
 * @param {string} [conversationId] - 对话 ID，传入则启用亲和
 * @returns {{ id, api_key, base_url, group_multiplier } | null}
 */
function acquire(conversationId) {
  if (!initialized) init();
  if (keys.length === 0) return null;

  // 对话亲和：优先使用该对话绑定的密钥
  if (conversationId) {
    const boundKeyId = conversationKeyMap.get(conversationId);
    if (boundKeyId != null) {
      const boundKey = keys.find(k => k.id === boundKeyId);
      if (boundKey && boundKey.health_status !== 'down') {
        const current = concurrencyMap.get(boundKeyId) || 0;
        if (current < boundKey.max_concurrency) {
          concurrencyMap.set(boundKeyId, current + 1);
          return { id: boundKey.id, api_key: boundKey.api_key, base_url: boundKey.base_url, group_multiplier: boundKey.group_multiplier || 1.0 };
        }
        // 并发满了，仍然走下面的轮询，但不清除绑定（下次可能就空了）
      } else {
        // key 被删除或 down 了，清除绑定，重新分配
        conversationKeyMap.delete(conversationId);
      }
    }
  }

  // 筛选可用密钥：健康状态非 down、并发未满
  const available = keys.filter(k => {
    const current = concurrencyMap.get(k.id) || 0;
    return k.health_status !== 'down' && current < k.max_concurrency;
  });

  if (available.length === 0) return null;

  // 加权随机选择
  const totalWeight = available.reduce((sum, k) => sum + (k.weight || 1), 0);
  let rand = Math.random() * totalWeight;
  let selected = available[0];
  for (const k of available) {
    rand -= (k.weight || 1);
    if (rand <= 0) { selected = k; break; }
  }

  concurrencyMap.set(selected.id, (concurrencyMap.get(selected.id) || 0) + 1);

  // 绑定对话到该密钥
  if (conversationId) {
    conversationKeyMap.set(conversationId, selected.id);
  }

  return { id: selected.id, api_key: selected.api_key, base_url: selected.base_url, group_multiplier: selected.group_multiplier || 1.0 };
}

// PLACEHOLDER_POOL_METHODS

function release(keyId) {
  const current = concurrencyMap.get(keyId) || 0;
  if (current > 0) {
    concurrencyMap.set(keyId, current - 1);
  }
}

function clearAffinity(conversationId) {
  if (conversationId) conversationKeyMap.delete(conversationId);
}

function recordSuccess(keyId, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens) {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE api_keys SET
        daily_tokens_input = daily_tokens_input + ?,
        daily_tokens_output = daily_tokens_output + ?,
        daily_request_count = daily_request_count + 1,
        last_request_at = CURRENT_TIMESTAMP,
        consecutive_errors = 0,
        health_status = 'healthy',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(inputTokens || 0, outputTokens || 0, keyId);

    // 更新内存中的健康状态
    const k = keys.find(k => k.id === keyId);
    if (k) {
      k.consecutive_errors = 0;
      k.health_status = 'healthy';
    }

    // 更新每日统计
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO api_key_daily_stats (api_key_id, date, tokens_input, tokens_output, cache_creation_tokens, cache_read_tokens, request_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(api_key_id, date) DO UPDATE SET
        tokens_input = tokens_input + ?,
        tokens_output = tokens_output + ?,
        cache_creation_tokens = cache_creation_tokens + ?,
        cache_read_tokens = cache_read_tokens + ?,
        request_count = request_count + 1
    `).run(
      keyId, today,
      inputTokens || 0, outputTokens || 0, cacheCreationTokens || 0, cacheReadTokens || 0,
      inputTokens || 0, outputTokens || 0, cacheCreationTokens || 0, cacheReadTokens || 0
    );
  } catch (err) {
    console.error('[KeyPool] recordSuccess error:', err);
  }
}

function recordCostUnits(keyId, costUnits) {
  const db = getDb();
  try {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO api_key_daily_stats (api_key_id, date, cost_units)
      VALUES (?, ?, ?)
      ON CONFLICT(api_key_id, date) DO UPDATE SET
        cost_units = cost_units + ?
    `).run(keyId, today, costUnits, costUnits);
  } catch (err) {
    console.error('[KeyPool] recordCostUnits error:', err);
  }
}

function recordError(keyId, errorMsg) {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE api_keys SET
        last_error = ?,
        consecutive_errors = consecutive_errors + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(errorMsg || 'unknown', keyId);

    const row = db.prepare('SELECT consecutive_errors FROM api_keys WHERE id = ?').get(keyId);
    const errors = row ? row.consecutive_errors : 0;

    let newStatus = 'healthy';
    if (errors >= 5) newStatus = 'down';
    else if (errors >= 3) newStatus = 'degraded';

    if (newStatus !== 'healthy') {
      db.prepare('UPDATE api_keys SET health_status = ? WHERE id = ?').run(newStatus, keyId);
    }

    // 更新内存
    const k = keys.find(k => k.id === keyId);
    if (k) {
      k.consecutive_errors = errors;
      k.health_status = newStatus;
    }

    // 更新每日错误统计
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`
      INSERT INTO api_key_daily_stats (api_key_id, date, error_count)
      VALUES (?, ?, 1)
      ON CONFLICT(api_key_id, date) DO UPDATE SET error_count = error_count + 1
    `).run(keyId, today);
  } catch (err) {
    console.error('[KeyPool] recordError error:', err);
  }
}

function getStatus() {
  return keys.map(k => ({
    id: k.id,
    base_url: k.base_url,
    relay_name: k.relay_name,
    enabled: k.enabled,
    health_status: k.health_status,
    max_concurrency: k.max_concurrency,
    current_concurrency: concurrencyMap.get(k.id) || 0,
    consecutive_errors: k.consecutive_errors,
    weight: k.weight,
    priority: k.priority,
  }));
}

function scheduleDailyReset() {
  if (dailyResetTimer) clearTimeout(dailyResetTimer);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const ms = tomorrow - now;

  dailyResetTimer = setTimeout(() => {
    archiveAndReset();
    scheduleDailyReset();
  }, ms);
}

function archiveAndReset() {
  const db = getDb();
  try {
    db.prepare(`
      UPDATE api_keys SET
        daily_tokens_input = 0,
        daily_tokens_output = 0,
        daily_request_count = 0
    `).run();
    console.log('[KeyPool] Daily counters reset');
  } catch (err) {
    console.error('[KeyPool] archiveAndReset error:', err);
  }
}

module.exports = { init, reload, acquire, release, clearAffinity, recordSuccess, recordError, recordCostUnits, getStatus };