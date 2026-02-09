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
