const config = require('./config');

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { init: initDb } = require('./db/init');
const authRoutes = require('./routes/auth');
const conversationsRoutes = require('./routes/conversations');
const chatRoutes = require('./routes/chat');
const userRoutes = require('./routes/user');
const auth = require('./middleware/auth');
const { chatRateLimit, authRateLimit } = require('./middleware/rateLimit');

const app = express();
const port = config.PORT;

const dataDir = path.join(__dirname, '..', 'data');
const uploadsDir = path.join(dataDir, 'uploads');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

initDb();

const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      return callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '2mb' }));

app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api/conversations', auth, conversationsRoutes);
app.use('/api/chat', auth, chatRateLimit, chatRoutes);
app.use('/api/user', auth, userRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`);
});
