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
