const { verifyToken } = require('../utils/token');

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  let token = match ? match[1] : null;

  // 支持 query 参数传 token（用于 img src 等无法设置 header 的场景）
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: '未提供认证令牌' });
  }

  try {
    const decoded = verifyToken(token);
    if (!decoded || typeof decoded !== 'object' || !decoded.userId) {
      return res.status(401).json({ error: '认证令牌无效或已过期' });
    }

    req.userId = decoded.userId;
    return next();
  } catch (err) {
    return res.status(401).json({ error: '认证令牌无效或已过期' });
  }
}

module.exports = auth;
