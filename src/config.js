require('dotenv').config();
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const API_BASE_URL = process.env.API_BASE_URL || '';
const API_KEY = process.env.API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const PAYMENT_APP_ID = process.env.PAYMENT_APP_ID || '';
const PAYMENT_APP_SECRET = process.env.PAYMENT_APP_SECRET || '';
const PAYMENT_CALLBACK_URL = process.env.PAYMENT_CALLBACK_URL || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

// 系统提示词文件路径
const SYSTEM_PROMPT_PATH = process.env.SYSTEM_PROMPT_PATH ||
  path.join(__dirname, 'prompts', 'system-opus-4.6.txt');

// === 上下文管理配置 ===
const CONTEXT_WINDOW = 200000;
const MAX_OUTPUT_TOKENS = 64000;
const SYSTEM_PROMPT_TOKENS = 20000;
const COMPACTION_THRESHOLD = 0.85;
const COMPACTION_KEEP_ROUNDS = 5;
const PRUNING_AGE_ROUNDS = 20;
const PRUNING_CODE_BLOCK_LIMIT = 2000;
const COMPACTION_MODEL = 'claude-haiku-4-5-20251001-thinking';
const MESSAGE_TOKEN_BUDGET = CONTEXT_WINDOW - SYSTEM_PROMPT_TOKENS - MAX_OUTPUT_TOKENS; // 164000
const COMPACTION_TRIGGER = Math.floor(MESSAGE_TOKEN_BUDGET * COMPACTION_THRESHOLD);     // 139400

// === 思考配置 ===
const THINKING_BUDGET_TOKENS = 50000;

// === 搜索服务配置 ===
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://47.236.55.33:9000/search';
const SEARXNG_API_KEY = process.env.SEARXNG_API_KEY || '4df411e8377cc049c243f3fdd11b67e8e60e21fdfd4ebee7';
const SEARXNG_TIMEOUT = 15000;
const SEARCH_MAX_RESULTS = 8;

// === 工具执行配置 ===
const TOOL_EXECUTION_TIMEOUT = 30000;
const TOOL_LOOP_MAX_ROUNDS = 10;

// === 文件上传配置 ===
const UPLOAD_MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB
const UPLOAD_MAX_FILES_PER_MESSAGE = 20;
const UPLOAD_ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const UPLOAD_ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'application/epub+zip',
];
const UPLOAD_ALLOWED_TEXT_EXTENSIONS = [
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.cs',
  '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.html', '.css', '.scss', '.less', '.sql', '.sh', '.bash',
  '.vue', '.svelte', '.lua', '.r', '.m', '.pl', '.ex', '.exs',
];

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Please set it in your .env file.');
}

module.exports = {
  PORT,
  JWT_SECRET,
  API_BASE_URL,
  API_KEY,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  PAYMENT_APP_ID,
  PAYMENT_APP_SECRET,
  PAYMENT_CALLBACK_URL,
  ADMIN_API_KEY,
  SYSTEM_PROMPT_PATH,
  CONTEXT_WINDOW,
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT_TOKENS,
  COMPACTION_THRESHOLD,
  COMPACTION_KEEP_ROUNDS,
  PRUNING_AGE_ROUNDS,
  PRUNING_CODE_BLOCK_LIMIT,
  COMPACTION_MODEL,
  MESSAGE_TOKEN_BUDGET,
  COMPACTION_TRIGGER,
  TOOL_EXECUTION_TIMEOUT,
  TOOL_LOOP_MAX_ROUNDS,
  THINKING_BUDGET_TOKENS,
  SEARXNG_URL,
  SEARXNG_API_KEY,
  SEARXNG_TIMEOUT,
  SEARCH_MAX_RESULTS,
  UPLOAD_MAX_FILE_SIZE,
  UPLOAD_MAX_FILES_PER_MESSAGE,
  UPLOAD_ALLOWED_IMAGE_TYPES,
  UPLOAD_ALLOWED_DOCUMENT_TYPES,
  UPLOAD_ALLOWED_TEXT_EXTENSIONS,
};

