const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/init');
const { ADMIN_API_KEY } = require('../config');
const { adminAuth, superAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// 字符集：去掉容易混淆的 O I L 0 1
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode() {
  const parts = [];
  for (let p = 0; p < 4; p++) {
    let seg = '';
    for (let i = 0; i < 4; i++) {
      const idx = crypto.randomInt(CHARSET.length);
      seg += CHARSET[idx];
    }
    parts.push(seg);
  }
  return parts.join('-');
}

// 旧的管理员密钥鉴权（保留兼容兑换码接口）
function legacyAdminAuth(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(500).json({ error: 'ADMIN_API_KEY 未配置' });
  }
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: '管理员密钥无效' });
  }
  return next();
}

// ==================== Dashboard ====================

router.get('/dashboard', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const todayNewUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE created_at >= date('now')").get().count;
    const todayMessages = db.prepare("SELECT COUNT(*) as count FROM messages WHERE created_at >= date('now')").get().count;

    const todayTokens = db.prepare(`
      SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output
      FROM messages WHERE created_at >= date('now') AND role = 'assistant'
    `).get();

    const keyStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) as enabled,
        SUM(CASE WHEN health_status = 'healthy' AND enabled = 1 THEN 1 ELSE 0 END) as healthy,
        SUM(CASE WHEN health_status = 'down' THEN 1 ELSE 0 END) as down
      FROM api_keys
    `).get();

    const activeSubscriptions = db.prepare(
      "SELECT COUNT(*) as count FROM user_subscriptions WHERE status = 'active' AND expires_at > datetime('now')"
    ).get().count;

    const todayCostRow = db.prepare(`
      SELECT COALESCE(SUM(s.cost_units), 0) as cost
      FROM api_key_daily_stats s
      WHERE s.date = date('now')
    `).get();

    const todayRevenueRow = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as revenue FROM orders WHERE status = 'paid' AND date(paid_at) = date('now')"
    ).get();

    // Profit data
    const monthRevenue = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as v FROM orders WHERE status = 'paid' AND paid_at >= date('now', 'start of month')"
    ).get().v;
    const monthRecharge = db.prepare(
      "SELECT COALESCE(SUM(amount_cny), 0) as v FROM recharge_records WHERE created_at >= date('now', 'start of month')"
    ).get().v;
    const totalRevenue = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) as v FROM orders WHERE status = 'paid'"
    ).get().v;
    const totalRecharge = db.prepare(
      "SELECT COALESCE(SUM(amount_cny), 0) as v FROM recharge_records"
    ).get().v;

    return res.json({
      totalUsers,
      todayNewUsers,
      todayMessages,
      todayTokensInput: todayTokens.input,
      todayTokensOutput: todayTokens.output,
      keyPool: keyStats,
      activeSubscriptions,
      todayCost: todayCostRow.cost, // cost_units ($0.0001 = 1 unit)
      todayRevenue: todayRevenueRow.revenue,
      profit: {
        monthRevenue,
        monthRecharge,
        totalRevenue,
        totalRecharge,
      },
    });
  } catch (err) {
    return next(err);
  }
});

// ==================== API Keys ====================

router.get('/keys', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const keys = db.prepare('SELECT * FROM api_keys ORDER BY priority DESC, id ASC').all();
    // 掩码 api_key
    const masked = keys.map(k => ({
      ...k,
      api_key: k.api_key.slice(0, 8) + '...' + k.api_key.slice(-4),
    }));
    return res.json(masked);
  } catch (err) {
    return next(err);
  }
});

router.post('/keys', adminAuth, (req, res, next) => {
  const { api_key, base_url, relay_name, relay_url, max_concurrency, priority, weight, note, input_rate, output_rate, group_multiplier, charge_rate } = req.body || {};
  if (!api_key || !base_url) {
    return res.status(400).json({ error: '缺少 api_key 或 base_url' });
  }
  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO api_keys (api_key, base_url, relay_name, relay_url, max_concurrency, priority, weight, note, input_rate, output_rate, group_multiplier, charge_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      api_key, base_url,
      relay_name || null, relay_url || null,
      max_concurrency || 3, priority || 0, weight || 1, note || null,
      input_rate || 0, output_rate || 0, group_multiplier || 1.0, charge_rate || 0
    );
    // 通知密钥池刷新
    try { require('../lib/keyPool').reload(); } catch (e) { /* pool not initialized yet */ }
    return res.json({ id: result.lastInsertRowid });
  } catch (err) {
    return next(err);
  }
});

// ==================== Plans ====================

router.get('/plans', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const plans = db.prepare('SELECT * FROM plans ORDER BY id ASC').all();
    return res.json(plans);
  } catch (err) { return next(err); }
});

router.post('/plans', adminAuth, (req, res, next) => {
  const { name, price, duration_days, token_quota, storage_quota, description, window_budget, weekly_budget } = req.body || {};
  if (!name || price === undefined || !duration_days || !token_quota) {
    return res.status(400).json({ error: '缺少必填字段' });
  }
  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO plans (name, price, duration_days, token_quota, storage_quota, description, window_budget, weekly_budget) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(name, price, duration_days, token_quota, storage_quota || 104857600, description || null, window_budget || 0, weekly_budget || 0);
    return res.json({ id: result.lastInsertRowid });
  } catch (err) { return next(err); }
});

router.put('/plans/:id', adminAuth, (req, res, next) => {
  const { id } = req.params;
  const { name, price, duration_days, token_quota, storage_quota, description, is_active, window_budget, weekly_budget } = req.body || {};
  const db = getDb();
  try {
    const existing = db.prepare('SELECT id FROM plans WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '套餐不存在' });
    const updates = [];
    const values = [];
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (price !== undefined) { updates.push('price = ?'); values.push(price); }
    if (duration_days !== undefined) { updates.push('duration_days = ?'); values.push(duration_days); }
    if (token_quota !== undefined) { updates.push('token_quota = ?'); values.push(token_quota); }
    if (storage_quota !== undefined) { updates.push('storage_quota = ?'); values.push(storage_quota); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (is_active !== undefined) { updates.push('is_active = ?'); values.push(is_active); }
    if (window_budget !== undefined) { updates.push('window_budget = ?'); values.push(window_budget); }
    if (weekly_budget !== undefined) { updates.push('weekly_budget = ?'); values.push(weekly_budget); }
    if (updates.length === 0) return res.status(400).json({ error: '无更新字段' });
    db.prepare(`UPDATE plans SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);

    // Sync active subscriptions with updated plan quotas
    if (token_quota !== undefined) {
      db.prepare(
        "UPDATE user_subscriptions SET token_quota = ? WHERE plan_id = ? AND status = 'active' AND expires_at > datetime('now')"
      ).run(token_quota, id);
    }

    return res.json({ success: true });
  } catch (err) { return next(err); }
});

router.delete('/plans/:id', adminAuth, (req, res, next) => {
  const { id } = req.params;
  const db = getDb();
  try {
    const activeSubs = db.prepare(
      "SELECT COUNT(*) as count FROM user_subscriptions WHERE plan_id = ? AND status = 'active' AND expires_at > datetime('now')"
    ).get(id).count;
    if (activeSubs > 0) {
      return res.status(400).json({ error: `该套餐有 ${activeSubs} 个活跃订阅，请先下架` });
    }
    const result = db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: '套餐不存在' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

router.post('/plans/:id/toggle', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const plan = db.prepare('SELECT id, is_active FROM plans WHERE id = ?').get(req.params.id);
    if (!plan) return res.status(404).json({ error: '套餐不存在' });
    const newActive = plan.is_active ? 0 : 1;
    db.prepare('UPDATE plans SET is_active = ? WHERE id = ?').run(newActive, plan.id);
    return res.json({ is_active: newActive });
  } catch (err) { return next(err); }
});

// ==================== Models ====================

router.get('/models', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const models = db.prepare('SELECT * FROM models ORDER BY created_at ASC').all();
    return res.json(models);
  } catch (err) { return next(err); }
});

router.post('/models', adminAuth, (req, res, next) => {
  const { id, name, model_multiplier, output_multiplier, cache_read_multiplier, cache_creation_multiplier } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: '缺少 id 或 name' });
  const db = getDb();
  try {
    db.prepare(
      'INSERT INTO models (id, name, model_multiplier, output_multiplier, cache_read_multiplier, cache_creation_multiplier) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, model_multiplier || 1.0, output_multiplier || 5.0, cache_read_multiplier || 0.1, cache_creation_multiplier || 2.0);
    try { require('../lib/billing').invalidateCache(); } catch (e) {}
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

router.put('/models/:id', adminAuth, (req, res, next) => {
  const { id } = req.params;
  const { name, model_multiplier, output_multiplier, cache_read_multiplier, cache_creation_multiplier, enabled } = req.body || {};
  const db = getDb();
  try {
    const existing = db.prepare('SELECT id FROM models WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '模型不存在' });
    const updates = [];
    const values = [];
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (model_multiplier !== undefined) { updates.push('model_multiplier = ?'); values.push(model_multiplier); }
    if (output_multiplier !== undefined) { updates.push('output_multiplier = ?'); values.push(output_multiplier); }
    if (cache_read_multiplier !== undefined) { updates.push('cache_read_multiplier = ?'); values.push(cache_read_multiplier); }
    if (cache_creation_multiplier !== undefined) { updates.push('cache_creation_multiplier = ?'); values.push(cache_creation_multiplier); }
    if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled); }
    if (updates.length === 0) return res.status(400).json({ error: '无更新字段' });
    db.prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
    try { require('../lib/billing').invalidateCache(); } catch (e) {}
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

router.delete('/models/:id', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const result = db.prepare('DELETE FROM models WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '模型不存在' });
    try { require('../lib/billing').invalidateCache(); } catch (e) {}
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

// ==================== Recharge Records ====================

router.get('/recharges', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const records = db.prepare('SELECT * FROM recharge_records ORDER BY created_at DESC LIMIT 200').all();
    return res.json(records);
  } catch (err) { return next(err); }
});

router.post('/recharges', adminAuth, (req, res, next) => {
  const { amount_cny, key_ids, remark } = req.body || {};
  if (!amount_cny || amount_cny <= 0) {
    return res.status(400).json({ error: '充值金额必须大于 0' });
  }
  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO recharge_records (amount_cny, key_ids, remark) VALUES (?, ?, ?)'
    ).run(amount_cny, JSON.stringify(key_ids || []), remark || null);
    return res.json({ id: result.lastInsertRowid });
  } catch (err) { return next(err); }
});

router.delete('/recharges/:id', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const result = db.prepare('DELETE FROM recharge_records WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '记录不存在' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

// PLACEHOLDER_ADMIN_ROUTES

router.put('/keys/:id', adminAuth, (req, res, next) => {
  const { id } = req.params;
  const { api_key, base_url, relay_name, relay_url, max_concurrency, priority, weight, note, input_rate, output_rate, group_multiplier, charge_rate } = req.body || {};
  const db = getDb();
  try {
    const existing = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '密钥不存在' });

    const updates = [];
    const values = [];
    if (api_key !== undefined && api_key !== '') { updates.push('api_key = ?'); values.push(api_key); }
    if (base_url !== undefined) { updates.push('base_url = ?'); values.push(base_url); }
    if (relay_name !== undefined) { updates.push('relay_name = ?'); values.push(relay_name || null); }
    if (relay_url !== undefined) { updates.push('relay_url = ?'); values.push(relay_url || null); }
    if (max_concurrency !== undefined) { updates.push('max_concurrency = ?'); values.push(max_concurrency); }
    if (priority !== undefined) { updates.push('priority = ?'); values.push(priority); }
    if (weight !== undefined) { updates.push('weight = ?'); values.push(weight); }
    if (note !== undefined) { updates.push('note = ?'); values.push(note || null); }
    if (input_rate !== undefined) { updates.push('input_rate = ?'); values.push(input_rate); }
    if (output_rate !== undefined) { updates.push('output_rate = ?'); values.push(output_rate); }
    if (group_multiplier !== undefined) { updates.push('group_multiplier = ?'); values.push(group_multiplier); }
    if (charge_rate !== undefined) { updates.push('charge_rate = ?'); values.push(charge_rate); }

    if (updates.length === 0) return res.status(400).json({ error: '无更新字段' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values, id);
    try { require('../lib/keyPool').reload(); } catch (e) { }
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.delete('/keys/:id', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '密钥不存在' });
    try { require('../lib/keyPool').reload(); } catch (e) { }
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post('/keys/:id/toggle', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const key = db.prepare('SELECT id, enabled FROM api_keys WHERE id = ?').get(req.params.id);
    if (!key) return res.status(404).json({ error: '密钥不存在' });
    const newEnabled = key.enabled ? 0 : 1;
    db.prepare('UPDATE api_keys SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newEnabled, key.id);
    try { require('../lib/keyPool').reload(); } catch (e) { }
    return res.json({ enabled: newEnabled });
  } catch (err) {
    return next(err);
  }
});

router.get('/keys/pool-status', adminAuth, (req, res, next) => {
  try {
    const pool = require('../lib/keyPool');
    return res.json(pool.getStatus());
  } catch (err) {
    return next(err);
  }
});

// ==================== Users ====================

router.get('/users', adminAuth, (req, res, next) => {
  const { page = 1, limit = 20, search, sort = 'created_at', order = 'desc' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitNum;

  const allowedSorts = ['created_at', 'email', 'token_used', 'updated_at'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

  const db = getDb();
  try {
    let where = '1=1';
    const params = [];
    if (search) {
      where += ' AND (email LIKE ? OR nickname LIKE ? OR id LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM users WHERE ${where}`).get(...params).count;
    const users = db.prepare(`
      SELECT u.id, u.email, u.nickname, u.role, u.plan, u.banned,
             u.token_quota, u.token_used, u.storage_quota, u.storage_used,
             u.created_at, u.updated_at,
             p.name as subscription_name, us.status as sub_status, us.expires_at as sub_expires,
             us.token_quota as sub_token_quota, us.tokens_used as sub_tokens_used,
             p.storage_quota as sub_storage_quota
      FROM users u
      LEFT JOIN user_subscriptions us ON us.user_id = u.id AND us.status = 'active' AND us.expires_at > datetime('now')
      LEFT JOIN plans p ON p.id = us.plan_id
      WHERE ${where.replace(/\b(email|nickname|id)\b/g, 'u.$1')}
      ORDER BY u.${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    return res.json({ users, pagination: { page: pageNum, limit: limitNum, total } });
  } catch (err) {
    return next(err);
  }
});

// PLACEHOLDER_USER_ACTIONS

router.post('/users/:id/ban', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const result = db.prepare('UPDATE users SET banned = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post('/users/:id/unban', adminAuth, (req, res, next) => {
  const db = getDb();
  try {
    const result = db.prepare('UPDATE users SET banned = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post('/users/:id/reset-password', adminAuth, (req, res, next) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  const db = getDb();
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('UPDATE users SET password_hash = ?, login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post('/users/:id/adjust-quota', adminAuth, (req, res, next) => {
  const { token_quota, storage_quota } = req.body || {};
  const db = getDb();
  try {
    // 优先修改活跃订阅的额度，没有订阅则修改用户基础额度
    const activeSub = db.prepare(
      "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY created_at ASC LIMIT 1"
    ).get(req.params.id);

    if (activeSub) {
      const updates = [];
      const values = [];
      if (token_quota !== undefined) { updates.push('token_quota = ?'); values.push(token_quota); }
      if (updates.length === 0) return res.status(400).json({ error: '无更新字段' });
      const result = db.prepare(`UPDATE user_subscriptions SET ${updates.join(', ')} WHERE id = ?`).run(...values, activeSub.id);
      if (result.changes === 0) return res.status(404).json({ error: '更新失败' });
    } else {
      const updates = [];
      const values = [];
      if (token_quota !== undefined) { updates.push('token_quota = ?'); values.push(token_quota); }
      if (storage_quota !== undefined) { updates.push('storage_quota = ?'); values.push(storage_quota); }
      if (updates.length === 0) return res.status(400).json({ error: '无更新字段' });
      updates.push('updated_at = CURRENT_TIMESTAMP');
      const result = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values, req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
    }

    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// 获取当前管理员信息（含角色）
router.get('/me', adminAuth, (req, res) => {
  return res.json({ userId: req.userId, role: req.userRole });
});

// 修改用户角色（仅超级管理员）
router.post('/users/:id/role', adminAuth, superAdminAuth, (req, res, next) => {
  const { role } = req.body || {};
  const validRoles = ['user', 'admin', 'superadmin'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: '无效角色，可选: user, admin, superadmin' });
  }
  if (req.params.id === req.userId) {
    return res.status(400).json({ error: '不能修改自己的角色' });
  }
  const db = getDb();
  try {
    const result = db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ==================== Redemption ====================

router.post('/redemption/generate', adminAuth, (req, res, next) => {
  const { plan_id, count, expires_days, note } = req.body || {};
  if (!plan_id || !count) {
    return res.status(400).json({ error: '缺少 plan_id 或 count' });
  }
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return res.status(400).json({ error: 'count 必须为 1-100 的整数' });
  }
  const db = getDb();
  try {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan_id);
    if (!plan) return res.status(404).json({ error: '套餐不存在' });

    const now = new Date();
    const batchId = `batch_${now.toISOString().slice(0, 10).replace(/-/g, '')}_${crypto.randomBytes(4).toString('hex')}`;
    const expiresAt = expires_days
      ? new Date(now.getTime() + expires_days * 86400000).toISOString().replace('T', ' ').slice(0, 19)
      : null;

    const insert = db.prepare(
      'INSERT INTO redemption_codes (code, plan_id, status, expires_at, batch_id, note) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const codes = [];
    const existingCodes = new Set(
      db.prepare('SELECT code FROM redemption_codes').all().map(r => r.code)
    );
    for (let i = 0; i < count; i++) {
      let code;
      let attempts = 0;
      do {
        code = generateCode();
        attempts++;
        if (attempts > 100) return res.status(500).json({ error: '生成兑换码失败，请重试' });
      } while (existingCodes.has(code));
      existingCodes.add(code);
      insert.run(code, plan_id, 'unused', expiresAt, batchId, note || null);
      codes.push(code);
    }
    console.log(`[Admin] Generated ${count} codes, batch=${batchId}, plan=${plan.name}`);
    return res.json({ codes, batch_id: batchId });
  } catch (err) {
    return next(err);
  }
});

router.get('/redemption/list', adminAuth, (req, res, next) => {
  const { status, batch_id, page = 1, limit = 20 } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitNum;
  const db = getDb();
  try {
    let where = '1=1';
    const params = [];
    if (status) { where += ' AND rc.status = ?'; params.push(status); }
    if (batch_id) { where += ' AND rc.batch_id = ?'; params.push(batch_id); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM redemption_codes rc WHERE ${where}`).get(...params).count;
    const stats = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) as unused,
        SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) as disabled
      FROM redemption_codes rc WHERE ${where}
    `).get(...params);
    const codes = db.prepare(`
      SELECT rc.*, p.name as plan_name
      FROM redemption_codes rc LEFT JOIN plans p ON p.id = rc.plan_id
      WHERE ${where} ORDER BY rc.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);
    return res.json({ codes, stats, pagination: { page: pageNum, limit: limitNum, total } });
  } catch (err) {
    return next(err);
  }
});

router.post('/redemption/disable', adminAuth, (req, res, next) => {
  const { codes } = req.body || {};
  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ error: '请提供要禁用的兑换码列表' });
  }
  const db = getDb();
  try {
    const stmt = db.prepare("UPDATE redemption_codes SET status = 'disabled' WHERE code = ? AND status = 'unused'");
    let updated = 0;
    for (const code of codes) {
      const result = stmt.run(code);
      updated += result.changes;
    }
    console.log(`[Admin] Disabled ${updated}/${codes.length} codes`);
    return res.json({ success: true, disabled: updated, total: codes.length });
  } catch (err) {
    return next(err);
  }
});

// ==================== Stats ====================

router.get('/stats/trends', adminAuth, (req, res, next) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const db = getDb();
  try {
    const daily = db.prepare(`
      SELECT d.date,
        COALESCE(msg.requests, 0) as requests,
        COALESCE(msg.tokens_input, 0) as tokens_input,
        COALESCE(msg.tokens_output, 0) as tokens_output,
        COALESCE(au.active_users, 0) as active_users,
        COALESCE(nu.new_users, 0) as new_users,
        COALESCE(rev.revenue, 0) as revenue
      FROM (
        SELECT date(datetime('now', '-' || n || ' days')) as date
        FROM (WITH RECURSIVE cnt(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM cnt WHERE n < ?) SELECT n FROM cnt) t
      ) d
      LEFT JOIN (
        SELECT date(m.created_at) as date, COUNT(*) as requests,
          SUM(m.input_tokens) as tokens_input, SUM(m.output_tokens) as tokens_output
        FROM messages m WHERE m.role = 'assistant' AND m.created_at >= date('now', '-' || ? || ' days')
        GROUP BY date(m.created_at)
      ) msg ON msg.date = d.date
      LEFT JOIN (
        SELECT date(m2.created_at) as date, COUNT(DISTINCT c.user_id) as active_users
        FROM messages m2 JOIN conversations c ON c.id = m2.conversation_id
        WHERE m2.created_at >= date('now', '-' || ? || ' days')
        GROUP BY date(m2.created_at)
      ) au ON au.date = d.date
      LEFT JOIN (
        SELECT date(created_at) as date, COUNT(*) as new_users
        FROM users WHERE created_at >= date('now', '-' || ? || ' days')
        GROUP BY date(created_at)
      ) nu ON nu.date = d.date
      LEFT JOIN (
        SELECT date(paid_at) as date, SUM(amount) as revenue
        FROM orders WHERE status = 'paid' AND paid_at >= date('now', '-' || ? || ' days')
        GROUP BY date(paid_at)
      ) rev ON rev.date = d.date
      ORDER BY d.date ASC
    `).all(days - 1, days, days, days, days);
    return res.json(daily);
  } catch (err) { return next(err); }
});

router.get('/stats/cost', adminAuth, (req, res, next) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const db = getDb();
  try {
    // Daily cost trend (cost_units, $0.0001 = 1 unit)
    const dailyCost = db.prepare(`
      SELECT s.date,
        SUM(s.cost_units) / 10000.0 as total_cost
      FROM api_key_daily_stats s
      WHERE s.date >= date('now', '-' || ? || ' days')
      GROUP BY s.date ORDER BY s.date ASC
    `).all(days);

    // Per-key today cost breakdown
    const todayKeys = db.prepare(`
      SELECT k.id, COALESCE(k.note, k.relay_name, 'Key #' || k.id) as label,
        COALESCE(s.tokens_input, 0) as tokens_input,
        COALESCE(s.tokens_output, 0) as tokens_output,
        COALESCE(s.cost_units, 0) / 10000.0 as total_cost
      FROM api_keys k
      LEFT JOIN api_key_daily_stats s ON s.api_key_id = k.id AND s.date = date('now')
      WHERE k.enabled = 1
      ORDER BY COALESCE(s.cost_units, 0) DESC
    `).all();

    return res.json({ dailyCost, todayKeys });
  } catch (err) { return next(err); }
});

module.exports = router;
