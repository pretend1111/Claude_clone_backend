const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/init');
const payment = require('../lib/payment');
const auth = require('../middleware/auth');

const router = express.Router();

// GET /api/payment/plans — 获取所有活跃套餐（无需登录）
router.get('/plans', (req, res, next) => {
  const db = getDb();
  try {
    const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
    return res.json(plans);
  } catch (err) {
    return next(err);
  }
});

// POST /api/payment/create — 创建订单（需登录）
router.post('/create', auth, (req, res, next) => {
  const { plan_id, payment_method } = req.body || {};

  if (!plan_id || !payment_method) {
    return res.status(400).json({ error: '缺少 plan_id 或 payment_method' });
  }
  if (!['wechat', 'alipay'].includes(payment_method)) {
    return res.status(400).json({ error: '不支持的支付方式' });
  }

  const db = getDb();
  try {
    const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(plan_id);
    if (!plan) {
      return res.status(404).json({ error: '套餐不存在或已下架' });
    }

    const orderId = uuidv4();
    db.prepare(
      'INSERT INTO orders (id, user_id, plan_id, amount, payment_method, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(orderId, req.userId, plan.id, plan.price, payment_method, 'pending');

    console.log(`[Payment] Order created: ${orderId}, plan=${plan.name}, amount=${plan.price}, user=${req.userId}`);

    // 调用支付适配层
    payment.createOrder({
      orderId,
      amount: plan.price,
      subject: plan.name,
      paymentMethod: payment_method,
    }).then(result => {
      // 更新 trade_no
      db.prepare('UPDATE orders SET trade_no = ? WHERE id = ?').run(result.tradeNo, orderId);
      return res.json({
        orderId,
        payUrl: result.payUrl,
        qrcodeUrl: result.qrcodeUrl,
      });
    }).catch(err => {
      console.error('[Payment] Create order failed:', err);
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(orderId);
      return res.status(500).json({ error: '创建支付订单失败' });
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/payment/callback — 支付回调（无需 auth 中间件）
router.post('/callback', (req, res, next) => {
  const params = req.body || {};

  // 验证签名
  if (!payment.verifyCallback(params)) {
    console.error('[Payment] Callback signature verification failed');
    return res.status(400).json({ error: '签名验证失败' });
  }

  const { order_id, amount, trade_no } = params;
  if (!order_id) {
    return res.status(400).json({ error: '缺少 order_id' });
  }

  const db = getDb();
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }

    // 幂等性：已支付的订单跳过
    if (order.status === 'paid') {
      console.log(`[Payment] Order ${order_id} already paid, skipping`);
      return res.json({ success: true });
    }

    // 金额校验
    if (Number(amount) !== order.amount) {
      console.error(`[Payment] Amount mismatch: callback=${amount}, order=${order.amount}`);
      return res.status(400).json({ error: '金额不匹配' });
    }

    // 更新订单状态
    db.prepare(
      "UPDATE orders SET status = 'paid', trade_no = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(trade_no || order.trade_no, order_id);

    // 查询套餐信息
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(order.plan_id);
    if (!plan) {
      console.error(`[Payment] Plan not found for order ${order_id}`);
      return res.status(500).json({ error: '套餐信息异常' });
    }

    // 检查是否有同类未过期订阅，延长而非覆盖
    const existingSub = db.prepare(
      "SELECT * FROM user_subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1"
    ).get(order.user_id);

    const subId = uuidv4();
    let startsAt, expiresAt;

    if (existingSub) {
      // 在现有订阅到期后开始
      startsAt = existingSub.expires_at;
      const baseDate = new Date(existingSub.expires_at);
      baseDate.setDate(baseDate.getDate() + plan.duration_days);
      expiresAt = baseDate.toISOString().replace('T', ' ').slice(0, 19);
    } else {
      startsAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + plan.duration_days);
      expiresAt = expDate.toISOString().replace('T', ' ').slice(0, 19);
    }

    db.prepare(
      'INSERT INTO user_subscriptions (id, user_id, plan_id, order_id, token_quota, tokens_used, starts_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'
    ).run(subId, order.user_id, plan.id, order_id, plan.token_quota, startsAt, expiresAt, 'active');

    // 更新用户存储配额（取套餐配额和当前配额的较大值）
    if (plan.storage_quota) {
      db.prepare('UPDATE users SET storage_quota = MAX(storage_quota, ?) WHERE id = ?').run(plan.storage_quota, order.user_id);
    }

    console.log(`[Payment] Subscription created: ${subId}, user=${order.user_id}, plan=${plan.name}, expires=${expiresAt}`);

    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// GET /api/payment/status/:orderId — 查询订单状态（需登录）
router.get('/status/:orderId', auth, (req, res, next) => {
  const db = getDb();
  try {
    const order = db.prepare(
      'SELECT id, user_id, plan_id, amount, payment_method, status, created_at, paid_at FROM orders WHERE id = ?'
    ).get(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }
    if (order.user_id !== req.userId) {
      return res.status(403).json({ error: '无权查看该订单' });
    }

    return res.json(order);
  } catch (err) {
    return next(err);
  }
});

// POST /api/payment/mock-pay/:orderId — 模拟支付（仅开发环境，需登录）
router.post('/mock-pay/:orderId', auth, (req, res, next) => {
  const db = getDb();
  try {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }
    if (order.user_id !== req.userId) {
      return res.status(403).json({ error: '无权操作' });
    }
    if (order.status === 'paid') {
      return res.json({ success: true, message: '已支付' });
    }

    // 直接标记为已支付
    db.prepare(
      "UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(order.id);

    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(order.plan_id);

    const existingSub = db.prepare(
      "SELECT * FROM user_subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > datetime('now') ORDER BY expires_at DESC LIMIT 1"
    ).get(order.user_id);

    const subId = uuidv4();
    let startsAt, expiresAt;

    if (existingSub) {
      startsAt = existingSub.expires_at;
      const baseDate = new Date(existingSub.expires_at);
      baseDate.setDate(baseDate.getDate() + plan.duration_days);
      expiresAt = baseDate.toISOString().replace('T', ' ').slice(0, 19);
    } else {
      startsAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + plan.duration_days);
      expiresAt = expDate.toISOString().replace('T', ' ').slice(0, 19);
    }

    db.prepare(
      'INSERT INTO user_subscriptions (id, user_id, plan_id, order_id, token_quota, tokens_used, starts_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'
    ).run(subId, order.user_id, plan.id, order.id, plan.token_quota, startsAt, expiresAt, 'active');

    if (plan.storage_quota) {
      db.prepare('UPDATE users SET storage_quota = MAX(storage_quota, ?) WHERE id = ?').run(plan.storage_quota, order.user_id);
    }

    console.log(`[Payment] Mock pay: order=${order.id}, sub=${subId}`);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
