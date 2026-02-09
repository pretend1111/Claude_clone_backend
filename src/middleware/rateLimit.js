const counters = new Map();

const WINDOW_MS = 60 * 1000;

const interval = setInterval(() => {
  counters.clear();
}, WINDOW_MS);

if (interval && typeof interval.unref === 'function') {
  interval.unref();
}

function createRateLimiter({ type, limit, getIdentifier }) {
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

const chatRateLimit = createRateLimiter({
  type: 'chat',
  limit: 20,
  getIdentifier(req) {
    return req.userId || req.ip || 'unknown';
  },
});

const authRateLimit = createRateLimiter({
  type: 'auth',
  limit: 10,
  getIdentifier(req) {
    return req.ip || 'unknown';
  },
});

module.exports = {
  chatRateLimit,
  authRateLimit,
};

