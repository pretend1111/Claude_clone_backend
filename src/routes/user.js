const express = require('express');
const bcrypt = require('bcryptjs');

const { getDb } = require('../db/init');
const { generateToken } = require('../utils/token');

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
            id, email, nickname, plan,
            token_quota, token_used, storage_quota, storage_used,
            full_name, display_name, work_function, personal_preferences,
            theme, chat_font, created_at
          FROM users
          WHERE id = ?
        `
      )
      .get(req.userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
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

    const tokenQuota = Number(user.token_quota) || 0;
    const tokenUsed = Number(user.token_used) || 0;
    const storageQuota = Number(user.storage_quota) || 0;
    const storageUsed = Number(user.storage_used) || 0;

    const tokenRemaining = tokenQuota - tokenUsed;
    const storageRemaining = storageQuota - storageUsed;

    return res.json({
      token_quota: tokenQuota,
      token_used: tokenUsed,
      token_remaining: tokenRemaining,
      usage_percent: toPercent(tokenUsed, tokenQuota),
      storage_quota: storageQuota,
      storage_used: storageUsed,
      storage_remaining: storageRemaining,
      storage_percent: toPercent(storageUsed, storageQuota),
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/profile', (req, res, next) => {
  const { nickname, password, full_name, display_name, work_function, personal_preferences, theme, chat_font } = req.body || {};

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
            id, email, nickname, plan,
            token_quota, token_used, storage_quota, storage_used,
            full_name, display_name, work_function, personal_preferences,
            theme, chat_font, created_at
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

module.exports = router;

