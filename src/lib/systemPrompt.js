const fs = require('fs');
const config = require('../config');
const { getDb } = require('../db/init');

let cachedSystemPrompt = null;

/**
 * 加载系统提示词到内存
 * 启动时调用一次，之后使用缓存
 */
function loadSystemPrompt() {
  if (cachedSystemPrompt) {
    return cachedSystemPrompt;
  }

  try {
    const content = fs.readFileSync(config.SYSTEM_PROMPT_PATH, 'utf-8');
    cachedSystemPrompt = content;
    return cachedSystemPrompt;
  } catch (err) {
    console.error(`Failed to load system prompt from ${config.SYSTEM_PROMPT_PATH}:`, err);
    // 返回默认的基础系统提示词
    cachedSystemPrompt = 'The assistant is Claude, created by Anthropic.\n\nThe current date is ' + new Date().toISOString().split('T')[0] + '.\n\nClaude is currently operating in a web-based AI chat platform for Chinese users.';
    return cachedSystemPrompt;
  }
}

/**
 * 获取系统提示词，可选注入用户偏好
 * @param {string} [userId] - 用户 ID，传入时注入用户偏好
 * @returns {string} 系统提示词内容
 */
function getSystemPrompt(userId) {
  const base = cachedSystemPrompt || loadSystemPrompt();
  if (!userId) return base;

  try {
    const db = getDb();
    const user = db.prepare(
      'SELECT display_name, work_function, personal_preferences FROM users WHERE id = ?'
    ).get(userId);

    if (!user) return base;

    const parts = [];
    if (user.display_name) parts.push(`用户名称：${user.display_name}`);
    if (user.work_function) parts.push(`用户职业：${user.work_function}`);
    if (user.personal_preferences) parts.push(`用户偏好指令：${user.personal_preferences}`);

    if (parts.length === 0) return base;

    return base + '\n\n<user_preferences>\n' + parts.join('\n') + '\n</user_preferences>';
  } catch (err) {
    console.error('[SystemPrompt] Failed to inject user preferences:', err);
    return base;
  }
}

module.exports = {
  loadSystemPrompt,
  getSystemPrompt,
};
