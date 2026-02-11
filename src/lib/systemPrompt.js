const fs = require('fs');
const config = require('../config');

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
 * 获取系统提示词
 * @returns {string} 系统提示词内容
 */
function getSystemPrompt() {
  return cachedSystemPrompt || loadSystemPrompt();
}

module.exports = {
  loadSystemPrompt,
  getSystemPrompt,
};
