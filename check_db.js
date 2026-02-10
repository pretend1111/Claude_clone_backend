const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'data', 'database.sqlite');
const db = new Database(dbPath);
const info = db.pragma('table_info(conversations)');
console.log(JSON.stringify(info, null, 2));
