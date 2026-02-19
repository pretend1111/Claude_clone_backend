const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Resend } = require('resend');

const config = require('../config');
const { getDb } = require('../db/init');
const { generateToken } = require('../utils/token');
const { loginRateLimit, registerRateLimit, sendCodeRateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const resend = new Resend(config.RESEND_API_KEY);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_SESSIONS = 5;
const LOCK_DURATION_MINUTES = 15;

function getLocationFromIp(ip) {
  if (!ip) return 'Unknown Location';
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return 'Local Network';
  }
  // TODO: Integrate real GeoIP service
  return 'Unknown Location';
}

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

// 生成 6 位数字验证码
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// 发送验证码邮件
async function sendVerificationEmail(email, code, type) {
  const subjectMap = {
    register: '注册验证码 - AI助手',
    reset: '密码重置验证码 - AI助手',
  };
  await resend.emails.send({
    from: config.RESEND_FROM_EMAIL,
    to: email,
    subject: subjectMap[type] || '验证码 - AI助手',
    html: `<p>您的验证码是：<strong>${code}</strong>，5分钟内有效。</p>`,
  });
}

// === 发送注册验证码 ===
router.post('/send-code', sendCodeRateLimit, async (req, res) => {
  const { email } = req.body || {};

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  const db = getDb();

  // 检查邮箱是否已注册
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: '邮箱已注册' });
  }

  // 60 秒防刷
  const recent = db.prepare(
    "SELECT id FROM verification_codes WHERE email = ? AND type = 'register' AND created_at > datetime('now', '-60 seconds')"
  ).get(email);
  if (recent) {
    return res.status(429).json({ error: '请 60 秒后再试' });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO verification_codes (email, code, type, expires_at) VALUES (?, ?, ?, ?)'
  ).run(email, code, 'register', expiresAt);

  try {
    await sendVerificationEmail(email, code, 'register');
    return res.json({ message: '验证码已发送' });
  } catch (err) {
    console.error('[Auth] 发送验证码失败:', err);
    return res.status(500).json({ error: '验证码发送失败，请稍后重试' });
  }
});

// === 注册（需要验证码） ===
router.post('/register', registerRateLimit, (req, res) => {
  const { email, password, nickname, code } = req.body || {};

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '密码至少 8 位' });
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: '密码必须包含字母和数字' });
  }
  if (typeof code !== 'string' || code.length !== 6) {
    return res.status(400).json({ error: '请输入 6 位验证码' });
  }

  const db = getDb();

  // 校验验证码
  const record = db.prepare(
    "SELECT id FROM verification_codes WHERE email = ? AND code = ? AND type = 'register' AND used = 0 AND expires_at > datetime('now')"
  ).get(email, code);
  if (!record) {
    return res.status(400).json({ error: '验证码无效或已过期' });
  }

  // 标记验证码已使用
  db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(record.id);

  const userId = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  try {
    db.prepare('INSERT INTO users (id, email, password_hash, nickname) VALUES (?, ?, ?, ?)').run(
      userId, email, passwordHash, nickname || null
    );
  } catch (err) {
    const message = err && err.message ? String(err.message) : '';
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: '邮箱已存在' });
    }
    if (message.includes('UNIQUE constraint failed: users.email')) {
      return res.status(409).json({ error: '邮箱已存在' });
    }
    console.error(err);
    return res.status(500).json({ error: '服务器内部错误' });
  }

  const user = db.prepare('SELECT id, email, nickname, plan FROM users WHERE id = ?').get(userId);
  const token = generateToken(userId);
  return res.json({ token, user });
});

// === 登录（含失败锁定） ===
router.post('/login', loginRateLimit, (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '参数错误' });
  }

  const db = getDb();
  const userRecord = db.prepare(
    'SELECT id, email, password_hash, nickname, plan, role, banned, login_attempts, locked_until FROM users WHERE email = ?'
  ).get(email);

  if (!userRecord) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  // 检查是否被封禁
  if (userRecord.banned) {
    return res.status(403).json({ error: '账号已被封禁' });
  }

  // 检查是否被锁定
  if (userRecord.locked_until && new Date(userRecord.locked_until) > new Date()) {
    const remaining = Math.ceil((new Date(userRecord.locked_until) - new Date()) / 60000);
    return res.status(423).json({ error: `账号已锁定，请 ${remaining} 分钟后再试` });
  }

  const ok = bcrypt.compareSync(password, userRecord.password_hash);
  if (!ok) {
    const attempts = (userRecord.login_attempts || 0) + 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?')
        .run(attempts, lockedUntil, userRecord.id);
      return res.status(423).json({ error: `连续失败 ${MAX_LOGIN_ATTEMPTS} 次，账号已锁定 ${LOCK_DURATION_MINUTES} 分钟` });
    }
    db.prepare('UPDATE users SET login_attempts = ? WHERE id = ?').run(attempts, userRecord.id);
    return res.status(401).json({ error: `邮箱或密码错误（还剩 ${MAX_LOGIN_ATTEMPTS - attempts} 次机会）` });
  }

  // 登录成功，清零
  db.prepare('UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?').run(userRecord.id);

  const token = generateToken(userRecord.id);

  // 创建会话记录
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const ua = req.headers['user-agent'] || '';
  const ip = req.headers['x-forwarded-for'] || req.ip || '';
  // Clean up IP (handle ::ffff: prefix)
  const cleanIp = ip.replace(/^::ffff:/, '');
  const device = parseDevice(ua);
  const sessionId = uuidv4();

  // 如果已有 >= MAX_SESSIONS 个会话，删除最旧的
  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE user_id = ?').get(userRecord.id).count;
  if (sessionCount >= MAX_SESSIONS) {
    db.prepare(
      'DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY last_active ASC LIMIT ?)'
    ).run(userRecord.id, sessionCount - MAX_SESSIONS + 1);
  }

  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, device, ip, location) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, userRecord.id, tokenHash, device, ip, getLocationFromIp(ip));

  const user = {
    id: userRecord.id,
    email: userRecord.email,
    nickname: userRecord.nickname,
    plan: userRecord.plan,
    role: userRecord.role || 'user',
  };
  return res.json({ token, user });
});

// === 忘记密码：发送重置验证码 ===
router.post('/forgot-password', sendCodeRateLimit, async (req, res) => {
  const { email } = req.body || {};

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  const db = getDb();

  // 不透露邮箱是否存在
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.json({ message: '如果该邮箱已注册，验证码已发送' });
  }

  // 60 秒防刷
  const recent = db.prepare(
    "SELECT id FROM verification_codes WHERE email = ? AND type = 'reset' AND created_at > datetime('now', '-60 seconds')"
  ).get(email);
  if (recent) {
    return res.status(429).json({ error: '请 60 秒后再试' });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO verification_codes (email, code, type, expires_at) VALUES (?, ?, ?, ?)'
  ).run(email, code, 'reset', expiresAt);

  try {
    await sendVerificationEmail(email, code, 'reset');
  } catch (err) {
    console.error('[Auth] 发送重置验证码失败:', err);
  }

  return res.json({ message: '如果该邮箱已注册，验证码已发送' });
});

// === 重置密码 ===
router.post('/reset-password', loginRateLimit, (req, res) => {
  const { email, code, password } = req.body || {};

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  if (typeof code !== 'string' || code.length !== 6) {
    return res.status(400).json({ error: '请输入 6 位验证码' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '密码至少 8 位' });
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return res.status(400).json({ error: '密码必须包含字母和数字' });
  }

  const db = getDb();

  const record = db.prepare(
    "SELECT id FROM verification_codes WHERE email = ? AND code = ? AND type = 'reset' AND used = 0 AND expires_at > datetime('now')"
  ).get(email, code);
  if (!record) {
    return res.status(400).json({ error: '验证码无效或已过期' });
  }

  db.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').run(record.id);

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db.prepare('UPDATE users SET password_hash = ?, login_attempts = 0, locked_until = NULL WHERE email = ?')
    .run(passwordHash, email);

  if (result.changes === 0) {
    return res.status(404).json({ error: '用户不存在' });
  }

  return res.json({ message: '密码重置成功，请重新登录' });
});

module.exports = router;
