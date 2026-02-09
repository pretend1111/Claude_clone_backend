const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/init');
const { generateToken } = require('../utils/token');

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', (req, res) => {
  const { email, password, nickname } = req.body || {};

  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }

  const userId = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  const db = getDb();
  try {
    db.prepare('INSERT INTO users (id, email, password_hash, nickname) VALUES (?, ?, ?, ?)').run(
      userId,
      email,
      passwordHash,
      nickname || null
    );
  } catch (err) {
    const message = err && err.message ? String(err.message) : '';
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: '邮箱已存在' });
    }
    if (message.includes('UNIQUE constraint failed: users.email')) {
      return res.status(409).json({ error: '邮箱已存在' });
    }
    // eslint-disable-next-line no-console
    console.error(err);
    return res.status(500).json({ error: '服务器内部错误' });
  }

  const user = db
    .prepare('SELECT id, email, nickname, plan FROM users WHERE id = ?')
    .get(userId);

  const token = generateToken(userId);
  return res.json({ token, user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: '参数错误' });
  }

  const db = getDb();
  const userRecord = db
    .prepare('SELECT id, email, password_hash, nickname, plan FROM users WHERE email = ?')
    .get(email);

  if (!userRecord) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  const ok = bcrypt.compareSync(password, userRecord.password_hash);
  if (!ok) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  const token = generateToken(userRecord.id);
  const user = {
    id: userRecord.id,
    email: userRecord.email,
    nickname: userRecord.nickname,
    plan: userRecord.plan,
  };

  return res.json({ token, user });
});

module.exports = router;
