const express = require('express');
const bcrypt = require('bcryptjs');

const { getDb } = require('../db/init');

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
            id,
            email,
            nickname,
            plan,
            token_quota,
            token_used,
            storage_quota,
            storage_used,
            created_at
          FROM users
          WHERE id = ?
        `
      )
      .get(req.userId);

    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }

    return res.json(user);
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
  const { nickname, password } = req.body || {};

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
            id,
            email,
            nickname,
            plan,
            token_quota,
            token_used,
            storage_quota,
            storage_used,
            created_at
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

