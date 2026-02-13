const path = require('path');

const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'database.sqlite');

let dbInstance;

function init() {
  if (dbInstance) return dbInstance;

  const db = new Database(DB_PATH);

  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT,
      plan TEXT DEFAULT 'free',
      token_quota INTEGER DEFAULT 1000000,
      token_used INTEGER DEFAULT 0,
      storage_quota INTEGER DEFAULT 104857600,
      storage_used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT DEFAULT '新对话',
      model TEXT DEFAULT 'claude-opus-4-6-thinking',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      has_attachments INTEGER DEFAULT 0 CHECK (has_attachments IN (0, 1)),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attachments (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      file_type TEXT NOT NULL CHECK (file_type IN ('image')),
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      extracted_text TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_user_id ON attachments(user_id);
  `);

  // === 数据库迁移：上下文管理系统 ===
  const messageColumns = db.pragma('table_info(messages)');
  const columnNames = new Set(messageColumns.map(col => col.name));

  if (!columnNames.has('input_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN input_tokens INTEGER DEFAULT 0');
  }
  if (!columnNames.has('output_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN output_tokens INTEGER DEFAULT 0');
  }
  if (!columnNames.has('is_summary')) {
    db.exec('ALTER TABLE messages ADD COLUMN is_summary INTEGER DEFAULT 0');
  }
  if (!columnNames.has('compacted')) {
    db.exec('ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0');
  }

  // === 数据库迁移：attachments 表添加 id 列 + 扩展 file_type ===
  const attachmentColumns = db.pragma('table_info(attachments)');
  const attachmentColumnNames = new Set(attachmentColumns.map(col => col.name));

  if (!attachmentColumnNames.has('id')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('ALTER TABLE attachments RENAME TO attachments_old');
    db.exec(`
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL,
        file_type TEXT NOT NULL CHECK (file_type IN ('image', 'document', 'text')),
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        extracted_text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_user_id ON attachments(user_id);
    `);
    db.exec(`
      INSERT INTO attachments (id, message_id, user_id, file_type, file_name, file_path, file_size, mime_type, extracted_text, created_at)
      SELECT hex(randomblob(16)), message_id, user_id, file_type, file_name, file_path, file_size, mime_type, extracted_text, created_at
      FROM attachments_old
    `);
    db.exec('DROP TABLE attachments_old');
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[DB] Migrated attachments table: added id column, expanded file_type');
  }

  // === 数据库迁移：verification_codes 表 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'register',
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON verification_codes(email);
  `);

  // === 数据库迁移：users 表增加 login_attempts / locked_until ===
  const userColumns = db.pragma('table_info(users)');
  const userColumnNames = new Set(userColumns.map(col => col.name));
  if (!userColumnNames.has('login_attempts')) {
    db.exec('ALTER TABLE users ADD COLUMN login_attempts INTEGER DEFAULT 0');
  }
  if (!userColumnNames.has('locked_until')) {
    db.exec('ALTER TABLE users ADD COLUMN locked_until DATETIME');
  }

  // === 数据库迁移：users 表增加 profile 字段 ===
  if (!userColumnNames.has('full_name')) {
    db.exec('ALTER TABLE users ADD COLUMN full_name TEXT');
  }
  if (!userColumnNames.has('display_name')) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  if (!userColumnNames.has('work_function')) {
    db.exec('ALTER TABLE users ADD COLUMN work_function TEXT');
  }
  if (!userColumnNames.has('personal_preferences')) {
    db.exec('ALTER TABLE users ADD COLUMN personal_preferences TEXT');
  }
  if (!userColumnNames.has('theme')) {
    db.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'light'");
  }
  if (!userColumnNames.has('chat_font')) {
    db.exec("ALTER TABLE users ADD COLUMN chat_font TEXT DEFAULT 'default'");
  }

  // === 数据库迁移：套餐与支付系统 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      duration_days INTEGER NOT NULL,
      token_quota INTEGER NOT NULL,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      payment_method TEXT,
      trade_no TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      token_quota INTEGER NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      starts_at DATETIME NOT NULL,
      expires_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON user_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON user_subscriptions(status);
  `);

  // 预置套餐数据（仅在表为空时插入）
  const planCount = db.prepare('SELECT COUNT(*) as count FROM plans').get().count;
  if (planCount === 0) {
    const insertPlan = db.prepare(
      'INSERT INTO plans (name, price, duration_days, token_quota, description) VALUES (?, ?, ?, ?, ?)'
    );
    insertPlan.run('体验包', 990, 3, 2000000, '新人试水，体验 AI 对话');
    insertPlan.run('基础月卡', 4900, 30, 15000000, '超越官方 Pro，轻度使用管够');
    insertPlan.run('专业月卡', 9900, 30, 40000000, '对标官方 Max x5，日常重度使用');
    insertPlan.run('尊享月卡', 19900, 30, 100000000, '对标官方 Max x20，无限畅聊');
    console.log('[DB] Inserted default plans');
  }

  // === 数据库迁移：兑换码系统 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      plan_id INTEGER NOT NULL,
      status TEXT DEFAULT 'unused' CHECK (status IN ('unused','used','expired','disabled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME,
      used_by TEXT,
      expires_at DATETIME,
      batch_id TEXT,
      note TEXT,
      FOREIGN KEY (plan_id) REFERENCES plans(id),
      FOREIGN KEY (used_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_redemption_codes_code ON redemption_codes(code);
    CREATE INDEX IF NOT EXISTS idx_redemption_codes_status ON redemption_codes(status);
    CREATE INDEX IF NOT EXISTS idx_redemption_codes_batch_id ON redemption_codes(batch_id);
  `);

  // === 数据库迁移：plans 表增加 storage_quota 字段 ===
  const planColumns = db.pragma('table_info(plans)');
  const planColumnNames = new Set(planColumns.map(col => col.name));
  if (!planColumnNames.has('storage_quota')) {
    db.exec('ALTER TABLE plans ADD COLUMN storage_quota INTEGER DEFAULT 104857600');
    // 更新预置套餐的存储配额
    db.prepare('UPDATE plans SET storage_quota = ? WHERE name = ?').run(31457280, '体验包');       // 30MB
    db.prepare('UPDATE plans SET storage_quota = ? WHERE name = ?').run(104857600, '基础月卡');     // 100MB
    db.prepare('UPDATE plans SET storage_quota = ? WHERE name = ?').run(209715200, '专业月卡');     // 200MB
    db.prepare('UPDATE plans SET storage_quota = ? WHERE name = ?').run(524288000, '尊享月卡');     // 500MB
    console.log('[DB] Migrated plans table: added storage_quota');
  }

  dbInstance = db;
  return dbInstance;
}

function getDb() {
  return dbInstance || init();
}

function close() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = undefined;
  }
}

module.exports = {
  DB_PATH,
  getDb,
  init,
  close,
};
