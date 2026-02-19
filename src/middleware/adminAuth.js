const { verifyToken } = require('../utils/token');
const { getDb } = require('../db/init');

const ADMIN_ROLES = ['admin', 'superadmin'];

function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  let token = match ? match[1] : null;

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

    const db = getDb();
    const user = db.prepare('SELECT id, role, banned FROM users WHERE id = ?').get(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }
    if (user.banned) {
      return res.status(403).json({ error: '账号已被封禁' });
    }
    if (!ADMIN_ROLES.includes(user.role)) {
      return res.status(403).json({ error: '需要管理员权限' });
    }

    req.userId = decoded.userId;
    req.userRole = user.role;
    return next();
  } catch (err) {
    return res.status(401).json({ error: '认证令牌无效或已过期' });
  }
}

function superAdminAuth(req, res, next) {
  if (req.userRole !== 'superadmin') {
    return res.status(403).json({ error: '需要超级管理员权限' });
  }
  return next();
}

module.exports = { adminAuth, superAdminAuth };
