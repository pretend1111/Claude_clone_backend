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
      token_quota INTEGER DEFAULT 0,
      token_used INTEGER DEFAULT 0,
      storage_quota INTEGER DEFAULT 0,
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
  if (!columnNames.has('search_logs')) {
    db.exec('ALTER TABLE messages ADD COLUMN search_logs TEXT');
  }
  if (!columnNames.has('thinking')) {
    db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT');
  }
  if (!columnNames.has('thinking_summary')) {
    db.exec('ALTER TABLE messages ADD COLUMN thinking_summary TEXT');
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
  if (!userColumnNames.has('default_model')) {
    db.exec("ALTER TABLE users ADD COLUMN default_model TEXT DEFAULT 'claude-opus-4-6-thinking'");
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

  // === 数据库迁移：users 表增加 role / banned 字段 ===
  if (!userColumnNames.has('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    console.log('[DB] Migrated users table: added role');
  }
  if (!userColumnNames.has('banned')) {
    db.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0');
    console.log('[DB] Migrated users table: added banned');
  }

  // === 设置超级管理员 ===
  const superAdminUser = db.prepare("SELECT id, role FROM users WHERE email = '45385909@qq.com'").get();
  if (superAdminUser && superAdminUser.role !== 'superadmin') {
    db.prepare("UPDATE users SET role = 'superadmin' WHERE email = '45385909@qq.com'").run();
    console.log('[DB] Set 45385909@qq.com as superadmin');
  }

  // === sessions 表（设备登录管理）===
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      device TEXT,
      ip TEXT,
      location TEXT,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  // Migration: Add location column if missing
  const sessCols = db.pragma('table_info(sessions)');
  const sessColNames = new Set(sessCols.map(col => col.name));
  if (!sessColNames.has('location')) {
    db.exec('ALTER TABLE sessions ADD COLUMN location TEXT');
    console.log('[DB] Migrated sessions table: added location');
  }

  // === 数据库迁移：api_keys 表 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT NOT NULL,
      base_url TEXT NOT NULL,
      relay_name TEXT,
      relay_url TEXT,
      max_concurrency INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0,
      weight INTEGER DEFAULT 1,
      note TEXT,
      current_concurrency INTEGER DEFAULT 0,
      daily_tokens_input INTEGER DEFAULT 0,
      daily_tokens_output INTEGER DEFAULT 0,
      daily_request_count INTEGER DEFAULT 0,
      last_request_at DATETIME,
      last_error TEXT,
      consecutive_errors INTEGER DEFAULT 0,
      health_status TEXT DEFAULT 'healthy' CHECK (health_status IN ('healthy','degraded','down')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // === 数据库迁移：api_key_daily_stats 表 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_key_daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      request_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
      UNIQUE(api_key_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_daily_stats_date ON api_key_daily_stats(date);
  `);

  // === 数据库迁移：api_keys 表增加费率字段 ===
  const akCols = db.pragma('table_info(api_keys)');
  const akColNames = new Set(akCols.map(col => col.name));
  if (!akColNames.has('input_rate')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN input_rate REAL DEFAULT 0');
    console.log('[DB] Migrated api_keys: added input_rate');
  }
  if (!akColNames.has('output_rate')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN output_rate REAL DEFAULT 0');
    console.log('[DB] Migrated api_keys: added output_rate');
  }

  // === 数据库迁移：api_keys 表增加 group_multiplier ===
  if (!akColNames.has('group_multiplier')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN group_multiplier REAL DEFAULT 1.0');
    console.log('[DB] Migrated api_keys: added group_multiplier');
  }

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

  // === 数据库迁移：免费用户额度归零 ===
  // 将没有活跃订阅的用户的基础额度清零，只有付费套餐才有额度
  const freeQuotaMigrated = db.prepare(
    "SELECT COUNT(*) as count FROM users WHERE token_quota > 0 AND id NOT IN (SELECT user_id FROM user_subscriptions WHERE status = 'active' AND expires_at > datetime('now'))"
  ).get();
  if (freeQuotaMigrated.count > 0) {
    const result = db.prepare(
      "UPDATE users SET token_quota = 0, storage_quota = 0 WHERE id NOT IN (SELECT user_id FROM user_subscriptions WHERE status = 'active' AND expires_at > datetime('now'))"
    ).run();
    console.log(`[DB] Migrated free users quota to 0: ${result.changes} users updated`);
  }

  // === 数据库迁移：models 表（计费倍率配置）===
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model_multiplier REAL DEFAULT 1.0,
      output_multiplier REAL DEFAULT 5.0,
      cache_read_multiplier REAL DEFAULT 0.1,
      cache_creation_multiplier REAL DEFAULT 2.0,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 预置模型数据（仅表为空时插入）
  const modelCount = db.prepare('SELECT COUNT(*) as count FROM models').get().count;
  if (modelCount === 0) {
    const insertModel = db.prepare(
      'INSERT INTO models (id, name, model_multiplier, output_multiplier, cache_read_multiplier, cache_creation_multiplier) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insertModel.run('claude-opus-4-6', 'Opus 4.6', 2.5, 5.0, 0.1, 2.0);
    insertModel.run('claude-opus-4-5-20251101', 'Opus 4.5', 2.5, 5.0, 0.1, 2.0);
    insertModel.run('claude-sonnet-4-5-20250929', 'Sonnet 4.5', 1.5, 5.0, 0.1, 2.0);
    insertModel.run('claude-haiku-4-5-20251001', 'Haiku 4.5', 0.5, 5.0, 0.1, 2.0);
    console.log('[DB] Inserted default model configs');
  }

  // === 数据库迁移：api_key_daily_stats 增加缓存 token 和成本字段 ===
  const statsCols = db.pragma('table_info(api_key_daily_stats)');
  const statsColNames = new Set(statsCols.map(col => col.name));
  if (!statsColNames.has('cache_creation_tokens')) {
    db.exec('ALTER TABLE api_key_daily_stats ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0');
    console.log('[DB] Migrated api_key_daily_stats: added cache_creation_tokens');
  }
  if (!statsColNames.has('cache_read_tokens')) {
    db.exec('ALTER TABLE api_key_daily_stats ADD COLUMN cache_read_tokens INTEGER DEFAULT 0');
    console.log('[DB] Migrated api_key_daily_stats: added cache_read_tokens');
  }
  if (!statsColNames.has('cost_units')) {
    db.exec('ALTER TABLE api_key_daily_stats ADD COLUMN cost_units INTEGER DEFAULT 0');
    console.log('[DB] Migrated api_key_daily_stats: added cost_units');
  }

  // === 数据库迁移：messages 表增加缓存 token 字段 ===
  const msgCols2 = db.pragma('table_info(messages)');
  const msgColNames2 = new Set(msgCols2.map(col => col.name));
  if (!msgColNames2.has('cache_creation_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0');
    console.log('[DB] Migrated messages: added cache_creation_tokens');
  }
  if (!msgColNames2.has('cache_read_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER DEFAULT 0');
    console.log('[DB] Migrated messages: added cache_read_tokens');
  }
  if (!msgColNames2.has('document_json')) {
    db.exec('ALTER TABLE messages ADD COLUMN document_json TEXT');
    console.log('[DB] Migrated messages: added document_json');
  }
  if (!msgColNames2.has('thinking')) {
    db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT');
    console.log('[DB] Migrated messages: added thinking');
  }
  if (!msgColNames2.has('citations_json')) {
    db.exec('ALTER TABLE messages ADD COLUMN citations_json TEXT');
    console.log('[DB] Migrated messages: added citations_json');
  }

  // === 数据库迁移：套餐额度从 token 改为美元单位 ===
  // token_quota 字段含义改为美元额度 × 10000（$0.0001 = 1 unit）
  // 检测是否已迁移：如果体验包的 token_quota 还是 2000000（旧 token 值），则需要迁移
  const trialPlan = db.prepare("SELECT token_quota FROM plans WHERE name = '体验包'").get();
  if (trialPlan && trialPlan.token_quota === 2000000) {
    db.prepare("UPDATE plans SET token_quota = 100000 WHERE name = '体验包'").run();       // $10
    db.prepare("UPDATE plans SET token_quota = 400000 WHERE name = '基础月卡'").run();     // $40
    db.prepare("UPDATE plans SET token_quota = 1000000 WHERE name = '专业月卡'").run();    // $100
    db.prepare("UPDATE plans SET token_quota = 2000000 WHERE name = '尊享月卡'").run();    // $200
    // 重置所有订阅的已用额度（旧 token 数据不兼容新单位）
    db.prepare("UPDATE user_subscriptions SET tokens_used = 0").run();
    db.prepare("UPDATE users SET token_used = 0").run();
    console.log('[DB] Migrated plans token_quota to dollar units and reset usage');
  }

  // === 数据库迁移：调整套餐美元额度 ===
  // 体验包 $2 → $10, 基础月卡 $10 → $40, 专业月卡 $30 → $100, 尊享月卡 $80 → $200
  if (trialPlan && trialPlan.token_quota === 20000) {
    db.prepare("UPDATE plans SET token_quota = 100000 WHERE name = '体验包'").run();       // $10
    db.prepare("UPDATE plans SET token_quota = 400000 WHERE name = '基础月卡'").run();     // $40
    db.prepare("UPDATE plans SET token_quota = 1000000 WHERE name = '专业月卡'").run();    // $100
    db.prepare("UPDATE plans SET token_quota = 2000000 WHERE name = '尊享月卡'").run();    // $200
    // 同步已有订阅的额度为对应套餐的当前值
    db.prepare("UPDATE user_subscriptions SET token_quota = (SELECT token_quota FROM plans WHERE plans.id = user_subscriptions.plan_id) WHERE status = 'active'").run();
    console.log('[DB] Updated plans dollar quotas: 体验$10, 基础$40, 专业$100, 尊享$200');
  }

  // === 数据库迁移：api_keys 增加 charge_rate ===
  if (!akColNames.has('charge_rate')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN charge_rate REAL DEFAULT 0');
    console.log('[DB] Migrated api_keys: added charge_rate');
  }

  // === 数据库迁移：plans 增加 window_budget / weekly_budget ===
  const planCols2 = db.pragma('table_info(plans)');
  const planColNames2 = new Set(planCols2.map(col => col.name));
  if (!planColNames2.has('window_budget')) {
    db.exec('ALTER TABLE plans ADD COLUMN window_budget REAL DEFAULT 0');
    console.log('[DB] Migrated plans: added window_budget');
  }
  if (!planColNames2.has('weekly_budget')) {
    db.exec('ALTER TABLE plans ADD COLUMN weekly_budget REAL DEFAULT 0');
    console.log('[DB] Migrated plans: added weekly_budget');
  }

  // === 数据库迁移：user_subscriptions 增加窗口/周/赠送追踪字段 ===
  const subCols = db.pragma('table_info(user_subscriptions)');
  const subColNames = new Set(subCols.map(col => col.name));
  if (!subColNames.has('window_start')) {
    db.exec('ALTER TABLE user_subscriptions ADD COLUMN window_start DATETIME');
    console.log('[DB] Migrated user_subscriptions: added window_start');
  }
  if (!subColNames.has('window_used')) {
    db.exec('ALTER TABLE user_subscriptions ADD COLUMN window_used REAL DEFAULT 0');
    console.log('[DB] Migrated user_subscriptions: added window_used');
  }
  if (!subColNames.has('week_start')) {
    db.exec('ALTER TABLE user_subscriptions ADD COLUMN week_start DATETIME');
    console.log('[DB] Migrated user_subscriptions: added week_start');
  }
  if (!subColNames.has('week_used')) {
    db.exec('ALTER TABLE user_subscriptions ADD COLUMN week_used REAL DEFAULT 0');
    console.log('[DB] Migrated user_subscriptions: added week_used');
  }
  if (!subColNames.has('bonus_used')) {
    db.exec('ALTER TABLE user_subscriptions ADD COLUMN bonus_used REAL DEFAULT 0');
    console.log('[DB] Migrated user_subscriptions: added bonus_used');
  }

  // === 数据库迁移：新建 recharge_records 表 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS recharge_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_cny REAL NOT NULL,
      key_ids TEXT NOT NULL DEFAULT '[]',
      remark TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // === 数据库迁移：套餐额度 + 窗口/周预算迁移 ===
  const trialPlan2 = db.prepare("SELECT token_quota, window_budget FROM plans WHERE name = '体验包'").get();
  if (trialPlan2 && (!trialPlan2.window_budget || trialPlan2.window_budget === 0)) {
    // 更新套餐额度为真实美元值 × 10000
    db.prepare("UPDATE plans SET token_quota = 150000, window_budget = 5.0, weekly_budget = 0 WHERE name = '体验包'").run();
    db.prepare("UPDATE plans SET token_quota = 750000, window_budget = 6.0, weekly_budget = 17.3 WHERE name = '基础月卡'").run();
    db.prepare("UPDATE plans SET token_quota = 1500000, window_budget = 12.0, weekly_budget = 34.6 WHERE name = '专业月卡'").run();
    db.prepare("UPDATE plans SET token_quota = 3800000, window_budget = 30.0, weekly_budget = 87.8 WHERE name = '尊享月卡'").run();
    // 重置所有订阅的使用量
    db.prepare("UPDATE user_subscriptions SET tokens_used = 0, window_used = 0, week_used = 0, bonus_used = 0").run();
    db.prepare("UPDATE users SET token_used = 0").run();
    // 同步活跃订阅的额度
    db.prepare("UPDATE user_subscriptions SET token_quota = (SELECT token_quota FROM plans WHERE plans.id = user_subscriptions.plan_id) WHERE status = 'active'").run();
    console.log('[DB] Migrated plans to new quotas with window/weekly budgets and reset usage');
  }

  // === 数据库迁移：周预算改为 7.5 天周期（月额度 ÷ 4）===
  const basicPlanWb = db.prepare("SELECT weekly_budget FROM plans WHERE name = '基础月卡'").get();
  if (basicPlanWb && basicPlanWb.weekly_budget > 0 && basicPlanWb.weekly_budget < 18) {
    db.prepare("UPDATE plans SET weekly_budget = 18.75 WHERE name = '基础月卡'").run();
    db.prepare("UPDATE plans SET weekly_budget = 37.5 WHERE name = '专业月卡'").run();
    db.prepare("UPDATE plans SET weekly_budget = 95.0 WHERE name = '尊享月卡'").run();
    console.log('[DB] Updated weekly_budget to 7.5-day cycle: 基础18.75, 专业37.5, 尊享95');
  }

  // === 数据库迁移：api_keys 增加 key_type 列 ===
  const akCols2 = db.pragma('table_info(api_keys)');
  const akColNames2 = new Set(akCols2.map(col => col.name));
  if (!akColNames2.has('key_type')) {
    db.exec("ALTER TABLE api_keys ADD COLUMN key_type TEXT DEFAULT 'streaming' CHECK (key_type IN ('streaming','non_streaming'))");
    console.log('[DB] Migrated api_keys: added key_type');
  }

  // === 数据库迁移：plans 增加 plan_type 列 ===
  const planCols3 = db.pragma('table_info(plans)');
  const planColNames3 = new Set(planCols3.map(col => col.name));
  if (!planColNames3.has('plan_type')) {
    db.exec("ALTER TABLE plans ADD COLUMN plan_type TEXT DEFAULT 'streaming' CHECK (plan_type IN ('streaming','non_streaming'))");
    console.log('[DB] Migrated plans: added plan_type');
  }

  // === 数据库迁移：非流式套餐已废弃，跳过插入 ===
  // 保留 plan_type / key_type 列（SQLite 不支持 DROP COLUMN），只是不再使用 non_streaming 值
  const nsCount = db.prepare("SELECT COUNT(*) as count FROM plans WHERE plan_type = 'non_streaming'").get().count;
  if (nsCount === 0) {
    // 更新正常版套餐额度和预算
    db.prepare("UPDATE plans SET token_quota = 200000, window_budget = 0, weekly_budget = 0 WHERE name = '体验包' AND plan_type = 'streaming'").run();
    db.prepare("UPDATE plans SET token_quota = 1000000, window_budget = 8.0, weekly_budget = 25.0 WHERE name = '基础月卡' AND plan_type = 'streaming'").run();
    db.prepare("UPDATE plans SET token_quota = 2600000, window_budget = 20.8, weekly_budget = 65.0 WHERE name = '专业月卡' AND plan_type = 'streaming'").run();
    db.prepare("UPDATE plans SET token_quota = 5000000, window_budget = 39.5, weekly_budget = 125.0 WHERE name = '尊享月卡' AND plan_type = 'streaming'").run();

    // 同步活跃订阅的额度
    db.prepare("UPDATE user_subscriptions SET token_quota = (SELECT token_quota FROM plans WHERE plans.id = user_subscriptions.plan_id) WHERE status = 'active'").run();
    console.log('[DB] Updated streaming plan quotas');
  }

  // === 数据库迁移：体验包去掉窗口/周期限制 ===
  const trialWindowCheck = db.prepare("SELECT window_budget FROM plans WHERE name = '体验包' AND plan_type = 'streaming'").get();
  if (trialWindowCheck && trialWindowCheck.window_budget > 0) {
    db.prepare("UPDATE plans SET window_budget = 0, weekly_budget = 0 WHERE name = '体验包'").run();
    console.log('[DB] Cleared window_budget/weekly_budget for 体验包');
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
