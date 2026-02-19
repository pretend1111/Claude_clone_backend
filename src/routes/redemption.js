const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/init');
const auth = require('../middleware/auth');
const { redeemRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// POST /api/redemption/redeem — 用户兑换（需登录 + 限流）
router.post('/redeem', auth, redeemRateLimit, (req, res, next) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: '请输入兑换码' });
  }

  // 格式校验：去掉空格和横线后应为16位字母数字
  const cleaned = code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z0-9]{16}$/.test(cleaned)) {
    return res.status(400).json({ error: '兑换码格式不正确' });
  }

  // 格式化为标准格式查询
  const formatted = `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}`;

  const db = getDb();
  try {
    const record = db.prepare('SELECT * FROM redemption_codes WHERE code = ?').get(formatted);

    if (!record) {
      return res.status(404).json({ error: '兑换码无效' });
    }
    if (record.status !== 'unused') {
      const msgs = { used: '兑换码已被使用', expired: '兑换码已过期', disabled: '兑换码已失效' };
      return res.status(400).json({ error: msgs[record.status] || '兑换码不可用' });
    }
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      // 自动标记过期
      db.prepare("UPDATE redemption_codes SET status = 'expired' WHERE id = ?").run(record.id);
      return res.status(400).json({ error: '兑换码已过期' });
    }

    // 查询套餐
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(record.plan_id);
    if (!plan) {
      return res.status(500).json({ error: '套餐信息异常' });
    }

    // 事务执行
    const txn = db.transaction(() => {
      // 更新兑换码状态
      db.prepare(
        "UPDATE redemption_codes SET status = 'used', used_at = datetime('now'), used_by = ? WHERE id = ? AND status = 'unused'"
      ).run(req.userId, record.id);

      // 创建一条兑换类型的 order 记录，满足外键约束
      const orderId = `redeem-${uuidv4()}`;
      db.prepare(
        "INSERT INTO orders (id, user_id, plan_id, amount, payment_method, status, paid_at) VALUES (?, ?, ?, 0, 'redemption', 'paid', datetime('now'))"
      ).run(orderId, req.userId, plan.id);

      // 检查当前生效的订阅（升级场景）
      const activeSub = db.prepare(
        "SELECT s.*, p.price as current_price FROM user_subscriptions s JOIN plans p ON s.plan_id = p.id WHERE s.user_id = ? AND s.status = 'active' AND s.starts_at <= datetime('now') AND s.expires_at > datetime('now') ORDER BY p.price DESC LIMIT 1"
      ).get(req.userId);

      const subId = uuidv4();
      let startsAt, expiresAt, tokensUsed = 0;

      if (activeSub && plan.price > activeSub.current_price) {
        // 升级：保持原到期时间，沿用已使用额度
        startsAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
        expiresAt = activeSub.expires_at;
        tokensUsed = Number(activeSub.tokens_used) || 0;

        db.prepare(
          "UPDATE user_subscriptions SET status = 'upgraded' WHERE id = ?"
        ).run(activeSub.id);
      } else if (activeSub) {
        // 有活跃订阅但不是升级，在到期后开始
        startsAt = activeSub.expires_at;
        const baseDate = new Date(activeSub.expires_at);
        baseDate.setDate(baseDate.getDate() + plan.duration_days);
        expiresAt = baseDate.toISOString().replace('T', ' ').slice(0, 19);
      } else {
        startsAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const expDate = new Date();
        expDate.setDate(expDate.getDate() + plan.duration_days);
        expiresAt = expDate.toISOString().replace('T', ' ').slice(0, 19);
      }

      db.prepare(
        'INSERT INTO user_subscriptions (id, user_id, plan_id, order_id, token_quota, tokens_used, starts_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(subId, req.userId, plan.id, orderId, plan.token_quota, tokensUsed, startsAt, expiresAt, 'active');

      // 更新用户存储配额（取套餐配额和当前配额的较大值）
      if (plan.storage_quota) {
        db.prepare('UPDATE users SET storage_quota = MAX(storage_quota, ?) WHERE id = ?').run(plan.storage_quota, req.userId);
      }

      return { subId, expiresAt };
    });

    const result = txn();

    console.log(`[Redeem] code=${formatted}, user=${req.userId}, plan=${plan.name}, sub=${result.subId}`);

    return res.json({
      success: true,
      plan: {
        name: plan.name,
        duration_days: plan.duration_days,
        token_quota: plan.token_quota,
      },
      subscription: {
        expires_at: result.expiresAt,
      },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
