const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../db/init');
const { ADMIN_API_KEY } = require('../config');
const { adminRateLimit } = require('../middleware/rateLimit');

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

// 管理员密钥鉴权中间件
function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(500).json({ error: 'ADMIN_API_KEY 未配置' });
  }
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: '管理员密钥无效' });
  }
  return next();
}

// POST /api/admin/redemption/generate — 批量生成兑换码
router.post('/redemption/generate', adminAuth, adminRateLimit, (req, res, next) => {
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
    if (!plan) {
      return res.status(404).json({ error: '套餐不存在' });
    }

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
        if (attempts > 100) {
          return res.status(500).json({ error: '生成兑换码失败，请重试' });
        }
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

// GET /api/admin/redemption/list — 查询兑换码列表
router.get('/redemption/list', adminAuth, adminRateLimit, (req, res, next) => {
  const { status, batch_id, page = 1, limit = 20 } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (pageNum - 1) * limitNum;

  const db = getDb();
  try {
    let where = '1=1';
    const params = [];

    if (status) {
      where += ' AND rc.status = ?';
      params.push(status);
    }
    if (batch_id) {
      where += ' AND rc.batch_id = ?';
      params.push(batch_id);
    }

    const total = db.prepare(`SELECT COUNT(*) as count FROM redemption_codes rc WHERE ${where}`).get(...params).count;

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) as unused,
        SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) as disabled
      FROM redemption_codes rc WHERE ${where}
    `).get(...params);

    const codes = db.prepare(`
      SELECT rc.*, p.name as plan_name
      FROM redemption_codes rc
      LEFT JOIN plans p ON p.id = rc.plan_id
      WHERE ${where}
      ORDER BY rc.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    return res.json({
      codes,
      stats,
      pagination: { page: pageNum, limit: limitNum, total },
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/redemption/disable — 批量禁用兑换码
router.post('/redemption/disable', adminAuth, adminRateLimit, (req, res, next) => {
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

module.exports = router;
