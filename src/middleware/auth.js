const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { verifyToken } = require('../utils/token');
const { getDb } = require('../db/init');

function parseDevice(ua) {
  if (!ua) return '未知设备';
  let os = '未知';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';

  return browser ? `${os} · ${browser}` : os;
}

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

    // 检查用户是否被封禁
    const db = getDb();
    const user = db.prepare('SELECT banned FROM users WHERE id = ?').get(decoded.userId);
    if (user && user.banned) {
      return res.status(403).json({ error: '账号已被封禁' });
    }

    // 验证会话是否存在（被登出的会话将被拒绝）
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    let session = db.prepare('SELECT id FROM sessions WHERE token_hash = ? AND user_id = ?').get(tokenHash, decoded.userId);
    if (!session) {
      // 检查用户是否有任何会话记录
      const anySession = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?').get(decoded.userId);
      if (anySession && anySession.count > 0) {
        // 用户有会话记录但当前 token 不在其中 → 已被登出
        return res.status(401).json({ error: '会话已失效，请重新登录' });
      }
      // 旧 token 没有会话记录，自动补建
      const sessionId = uuidv4();
      const ua = req.headers['user-agent'] || '';
      const ip = req.headers['x-forwarded-for'] || req.ip || '';
      const device = parseDevice(ua);
      db.prepare(
        'INSERT INTO sessions (id, user_id, token_hash, device, ip) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, decoded.userId, tokenHash, device, ip);
      session = { id: sessionId };
    } else {
      // 更新最后活跃时间（每5分钟更新一次，避免频繁写入）
      db.prepare(
        "UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE id = ? AND last_active < datetime('now', '-5 minutes')"
      ).run(session.id);
    }

    req.userId = decoded.userId;
    req.tokenExp = decoded.exp;
    req.tokenHash = tokenHash;
    req.sessionId = session.id;
    return next();
  } catch (err) {
    return res.status(401).json({ error: '认证令牌无效或已过期' });
  }
}

module.exports = auth;
