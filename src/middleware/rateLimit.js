// 按窗口独立计数的限流器
// 每个 limiter 有自己的 counters + 窗口，互不干扰

function createRateLimiter({ type, limit, windowMs, getIdentifier }) {
  const counters = new Map();
  const window = windowMs || 60 * 1000;

  const interval = setInterval(() => { counters.clear(); }, window);
  if (interval && typeof interval.unref === 'function') interval.unref();

  return (req, res, next) => {
    try {
      const identifier = getIdentifier(req);
      const key = `${type}:${identifier}`;
      const count = (counters.get(key) || 0) + 1;
      counters.set(key, count);

      if (count > limit) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// 聊天：每用户每分钟 20 次
const chatRateLimit = createRateLimiter({
  type: 'chat',
  limit: 20,
  getIdentifier(req) { return req.userId || req.ip || 'unknown'; },
});

// 登录：每 IP 每分钟 10 次
const loginRateLimit = createRateLimiter({
  type: 'login',
  limit: 10,
  getIdentifier(req) { return req.ip || 'unknown'; },
});

// 注册：每 IP 每分钟 5 次
const registerRateLimit = createRateLimiter({
  type: 'register',
  limit: 5,
  getIdentifier(req) { return req.ip || 'unknown'; },
});

// 发送验证码：每邮箱每分钟 1 次（60秒防刷已在 auth.js 中实现，这里做每小时 10 次的兜底）
const sendCodeRateLimit = createRateLimiter({
  type: 'sendcode',
  limit: 10,
  windowMs: 60 * 60 * 1000, // 1 小时窗口
  getIdentifier(req) { return (req.body && req.body.email) || req.ip || 'unknown'; },
});

// 支付创建：每用户每分钟 5 次
const paymentCreateRateLimit = createRateLimiter({
  type: 'payment',
  limit: 5,
  getIdentifier(req) { return req.userId || req.ip || 'unknown'; },
});

// 兑换：每用户每分钟 10 次
const redeemRateLimit = createRateLimiter({
  type: 'redeem',
  limit: 10,
  getIdentifier(req) { return req.userId || req.ip || 'unknown'; },
});

// 管理员：每 IP 每分钟 20 次
const adminRateLimit = createRateLimiter({
  type: 'admin',
  limit: 20,
  getIdentifier(req) { return req.ip || 'unknown'; },
});

module.exports = {
  chatRateLimit,
  loginRateLimit,
  registerRateLimit,
  sendCodeRateLimit,
  paymentCreateRateLimit,
  redeemRateLimit,
  adminRateLimit,
};

