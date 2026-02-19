const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db/init');

// 按提示词文件路径缓存
const promptCache = new Map();

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

// 模型 -> 提示词文件的映射
const MODEL_PROMPT_FILES = {
  'claude-opus-4-6': 'system-opus-4.6.txt',
  'claude-opus-4-5': 'system-opus-4.6.txt',
  'claude-sonnet-4-6': 'system-sonnet-4.6.txt',
  'claude-sonnet-4-5': 'system-sonnet-4.6.txt',
  'claude-haiku-4-5': 'system-opus-4.6.txt',
};

const MODEL_DESCRIPTIONS = {
  'claude-opus-4-6': 'This iteration of Claude is Claude Opus 4.6 from the Claude 4.6 model family. The Claude 4.6 family currently consists of Claude Opus 4.6 and Claude Sonnet 4.6. Claude Opus 4.6 is the most advanced and intelligent model.',
  'claude-sonnet-4-6': 'This iteration of Claude is Claude Sonnet 4.6 from the Claude 4.6 model family. The Claude 4.6 family currently consists of Claude Opus 4.6 and Claude Sonnet 4.6. Claude Sonnet 4.6 is a smart, efficient model for everyday use.',
  'claude-sonnet-4-5': 'This iteration of Claude is Claude Sonnet 4.5 from the Claude 4.5 model family. The Claude 4.5 family currently consists of Claude Opus 4.5, Claude Sonnet 4.5, and Claude Haiku 4.5. Claude Sonnet 4.5 is a smart, efficient model for everyday use.',
  'claude-opus-4-5': 'This iteration of Claude is Claude Opus 4.5 from the Claude 4.5 model family. The Claude 4.5 family currently consists of Claude Opus 4.5, Claude Sonnet 4.5, and Claude Haiku 4.5. Claude Opus 4.5 is the most advanced model in the 4.5 family.',
  'claude-haiku-4-5': 'This iteration of Claude is Claude Haiku 4.5 from the Claude 4.5 model family. The Claude 4.5 family currently consists of Claude Opus 4.5, Claude Sonnet 4.5, and Claude Haiku 4.5. Claude Haiku 4.5 is the fastest model for quick answers.',
};

/**
 * 加载指定提示词文件（带缓存）
 */
function loadPromptFile(filePath) {
  if (promptCache.has(filePath)) {
    return promptCache.get(filePath);
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    promptCache.set(filePath, content);
    return content;
  } catch (err) {
    console.error(`Failed to load system prompt from ${filePath}:`, err);
    return null;
  }
}

const DEFAULT_PROMPT = 'The assistant is Claude, created by Anthropic.\n\nThe current date is ' + new Date().toISOString().split('T')[0] + '.\n\nClaude is currently operating in a web-based AI chat platform for Chinese users.';

/**
 * 兼容旧接口：加载默认提示词
 */
function loadSystemPrompt() {
  return loadPromptFile(config.SYSTEM_PROMPT_PATH) || DEFAULT_PROMPT;
}

const BUILTIN_PREFERENCES = `Always respond in the user's language (default: 简体中文) for all chats.
Always give thorough, comprehensive, well-structured answers for all chats. Match response depth to question complexity — simple questions get concise answers, complex questions get detailed analysis with examples.
You are Claude, made by Anthropic, for all chats. You are not Kiro.`;

/**
 * 获取系统提示词，根据模型选择对应提示词文件并注入用户偏好
 * @param {string} [userId] - 用户 ID
 * @param {string} [model] - 模型标识
 * @returns {string} 系统提示词内容
 */
function getSystemPrompt(userId, model) {
  const baseModel = model
    ? model.replace(/-thinking$/, '').replace(/-\d{8}(-thinking)?$/, '')
    : 'claude-opus-4-6';

  // 根据模型选择提示词文件
  const promptFile = MODEL_PROMPT_FILES[baseModel] || 'system-opus-4.6.txt';
  const promptPath = path.join(PROMPTS_DIR, promptFile);
  let base = loadPromptFile(promptPath) || loadSystemPrompt();

  // 替换模型描述占位符
  const desc = MODEL_DESCRIPTIONS[baseModel] || MODEL_DESCRIPTIONS['claude-opus-4-6'];
  base = base.replace('{{MODEL_DESCRIPTION}}', desc);

  if (!userId) return base;

  try {
    const db = getDb();
    const user = db.prepare(
      'SELECT display_name, work_function, personal_preferences FROM users WHERE id = ?'
    ).get(userId);

    if (!user) return base;

    const parts = [BUILTIN_PREFERENCES];
    if (user.display_name) parts.push(`用户名称：${user.display_name}`);
    if (user.work_function) parts.push(`用户职业：${user.work_function}`);
    if (user.personal_preferences) parts.push(`用户偏好指令：${user.personal_preferences}`);

    return base + '\n\n<userPreferences>\n' + parts.join('\n') + '\n</userPreferences>';
  } catch (err) {
    console.error('[SystemPrompt] Failed to inject user preferences:', err);
    return base;
  }
}

module.exports = {
  loadSystemPrompt,
  getSystemPrompt,
};
