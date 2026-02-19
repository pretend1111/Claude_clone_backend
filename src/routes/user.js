const express = require('express');
const bcrypt = require('bcryptjs');

const { getDb } = require('../db/init');
const { generateToken } = require('../utils/token');
const quotaEngine = require('../lib/quotaEngine');

const router = express.Router();

function toPercent(used, quota) {
  const q = Number(quota) || 0;
  const u = Number(used) || 0;
  if (q <= 0) return 0;
  return Number(((u / q) * 100).toFixed(2));
}

router.get('/profile', (req, res, next) => {
  const db = getDb();
  try {
    const user = db
      .prepare(
        `
          SELECT
            id, email, nickname, plan, role,
            token_quota, token_used, storage_quota, storage_used,
            full_name, display_name, work_function, personal_preferences,
            theme, chat_font, default_model, created_at
          FROM users
          WHERE id = ?
        `
      )
      .get(req.userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 检查是否被封禁
    if (user.banned) {
      return res.status(403).json({ error: '账号已被封禁' });
    }

    // Token 剩余不足 7 天时自动续期
    const result = { ...user };
    if (req.tokenExp) {
      const remainingDays = (req.tokenExp * 1000 - Date.now()) / (1000 * 60 * 60 * 24);
      if (remainingDays < 7) {
        result.newToken = generateToken(req.userId);
      }
    }

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.get('/usage', (req, res, next) => {
  const db = getDb();
  try {
    const user = db
      .prepare('SELECT token_quota, token_used, storage_quota, storage_used FROM users WHERE id = ?')
      .get(req.userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    // 标记过期订阅
    db.prepare(
      "UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active' AND expires_at <= datetime('now')"
    ).run(req.userId);

    // 查询活跃订阅
    const activeSub = db.prepare(
      "SELECT s.*, p.name as plan_name, p.price as plan_price, p.storage_quota as plan_storage_quota FROM user_subscriptions s LEFT JOIN plans p ON s.plan_id = p.id WHERE s.user_id = ? AND s.status = 'active' AND s.starts_at <= datetime('now') AND s.expires_at > datetime('now') ORDER BY p.price DESC LIMIT 1"
    ).get(req.userId);

    // 消息统计
    const todayMessages = db.prepare(
      "SELECT COUNT(*) as count FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.user_id = ? AND m.role = 'user' AND m.created_at >= date('now')"
    ).get(req.userId);
    const monthMessages = db.prepare(
      "SELECT COUNT(*) as count FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.user_id = ? AND m.role = 'user' AND m.created_at >= date('now', 'start of month')"
    ).get(req.userId);

    // 决定显示的额度（订阅优先）
    let tokenQuota, tokenUsed;
    if (activeSub) {
      tokenQuota = Number(activeSub.token_quota) || 0;
      tokenUsed = Number(activeSub.tokens_used) || 0;
    } else {
      tokenQuota = Number(user.token_quota) || 0;
      tokenUsed = Number(user.token_used) || 0;
    }

    // Convert internal units to dollar values ($0.0001 = 1 unit)
    const dollarQuota = tokenQuota / 10000;
    const dollarUsed = tokenUsed / 10000;
    const dollarRemaining = dollarQuota - dollarUsed;

    const storageQuota = activeSub && activeSub.plan_storage_quota
      ? Math.max(Number(user.storage_quota) || 0, Number(activeSub.plan_storage_quota))
      : Number(user.storage_quota) || 0;
    const storageUsed = Number(user.storage_used) || 0;

    const storageRemaining = storageQuota - storageUsed;

    return res.json({
      plan: activeSub ? {
        id: activeSub.plan_id,
        name: activeSub.plan_name,
        price: activeSub.plan_price,
        expires_at: activeSub.expires_at,
        status: 'active',
      } : null,
      token_quota: dollarQuota,
      token_used: dollarUsed,
      token_remaining: dollarRemaining,
      usage_percent: toPercent(tokenUsed, tokenQuota),
      storage_quota: storageQuota,
      storage_used: storageUsed,
      storage_remaining: storageRemaining,
      storage_percent: toPercent(storageUsed, storageQuota),
      messages: {
        today: todayMessages?.count || 0,
        month: monthMessages?.count || 0,
      },
      quota: quotaEngine.getQuotaInfo(req.userId),
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/profile', (req, res, next) => {
  const { nickname, password, full_name, display_name, work_function, personal_preferences, theme, chat_font, default_model } = req.body || {};

  const updates = [];
  const values = [];

  if (typeof nickname === 'string') {
    updates.push('nickname = ?');
    values.push(nickname);
  }

  if (typeof password === 'string') {
    if (password.length < 6) {
      return res.status(400).json({ error: '密码至少 6 位' });
    }
    const passwordHash = bcrypt.hashSync(password, 10);
    updates.push('password_hash = ?');
    values.push(passwordHash);
  }

  if (typeof full_name === 'string') {
    updates.push('full_name = ?');
    values.push(full_name);
  }
  if (typeof display_name === 'string') {
    updates.push('display_name = ?');
    values.push(display_name);
  }
  if (typeof work_function === 'string') {
    updates.push('work_function = ?');
    values.push(work_function);
  }
  if (typeof personal_preferences === 'string') {
    if (personal_preferences.length > 2000) {
      return res.status(400).json({ error: '偏好指令最多 2000 字符' });
    }
    updates.push('personal_preferences = ?');
    values.push(personal_preferences);
  }
  if (typeof theme === 'string' && ['light', 'auto', 'dark'].includes(theme)) {
    updates.push('theme = ?');
    values.push(theme);
  }
  if (typeof chat_font === 'string' && ['default', 'sans', 'system', 'dyslexic'].includes(chat_font)) {
    updates.push('chat_font = ?');
    values.push(chat_font);
  }
  if (typeof default_model === 'string') {
    updates.push('default_model = ?');
    values.push(default_model);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: '未提供可更新字段' });
  }

  const db = getDb();
  try {
    db.prepare(
      `
        UPDATE users
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `
    ).run(...values, req.userId);

    const user = db
      .prepare(
        `
          SELECT
            id, email, nickname, plan, role,
            token_quota, token_used, storage_quota, storage_used,
            full_name, display_name, work_function, personal_preferences,
            theme, chat_font, default_model, created_at
          FROM users
          WHERE id = ?
        `
      )
      .get(req.userId);

    return res.json(user);
  } catch (err) {
    return next(err);
  }
});

// === 会话管理 ===

// 获取当前用户的所有活跃会话
router.get('/sessions', (req, res, next) => {
  const db = getDb();
  try {
    const sessions = db.prepare(
      'SELECT id, device, ip, location, last_active, created_at FROM sessions WHERE user_id = ? ORDER BY last_active DESC'
    ).all(req.userId);
    return res.json({ sessions, currentSessionId: req.sessionId });
  } catch (err) { return next(err); }
});

// 登出指定会话
router.delete('/sessions/:id', (req, res, next) => {
  const db = getDb();
  try {
    if (req.params.id === req.sessionId) {
      return res.status(400).json({ error: '不能登出当前会话，请使用退出登录' });
    }
    const result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    if (result.changes === 0) return res.status(404).json({ error: '会话不存在' });
    return res.json({ success: true });
  } catch (err) { return next(err); }
});

// 登出所有其他会话
router.post('/sessions/logout-others', (req, res, next) => {
  const db = getDb();
  try {
    const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.userId, req.sessionId || '');
    return res.json({ success: true, count: result.changes });
  } catch (err) { return next(err); }
});

// === 修改密码（需要旧密码验证）===
router.post('/change-password', (req, res, next) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: '请提供当前密码和新密码' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  const db = getDb();
  try {
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (!bcrypt.compareSync(current_password, user.password_hash)) {
      return res.status(400).json({ error: '当前密码错误' });
    }

    const newHash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newHash, req.userId);

    // 修改密码后登出所有其他会话
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.userId, req.sessionId || '');

    return res.json({ success: true });
  } catch (err) { return next(err); }
});

// === 注销账号 ===
router.post('/delete-account', (req, res, next) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '请输入密码确认' });

  const db = getDb();
  try {
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(400).json({ error: '密码错误' });
    }

    // 检查是否有活跃订阅
    const activeSub = db.prepare(
      "SELECT s.id, p.name, s.expires_at FROM user_subscriptions s LEFT JOIN plans p ON s.plan_id = p.id WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at > datetime('now') LIMIT 1"
    ).get(req.userId);
    if (activeSub) {
      return res.status(400).json({
        error: `您当前有活跃订阅「${activeSub.name}」（到期时间：${activeSub.expires_at.slice(0, 10)}），请等待订阅到期后再注销账号`,
        code: 'HAS_SUBSCRIPTION',
      });
    }

    // 删除关联数据
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.userId);
    db.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)').run(req.userId);
    db.prepare('DELETE FROM conversations WHERE user_id = ?').run(req.userId);
    db.prepare('DELETE FROM user_subscriptions WHERE user_id = ?').run(req.userId);
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(req.userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.userId);

    return res.json({ success: true });
  } catch (err) { return next(err); }
});

module.exports = router;

