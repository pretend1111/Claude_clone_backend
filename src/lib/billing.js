const { getDb } = require('../db/init');

// In-memory cache for model configs
let modelConfigCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Load all model configs from DB, with caching
 */
function loadModelConfigs() {
  const now = Date.now();
  if (modelConfigCache && now - cacheTimestamp < CACHE_TTL) {
    return modelConfigCache;
  }
  const db = getDb();
  const rows = db.prepare('SELECT * FROM models WHERE enabled = 1').all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.id, row);
  }
  modelConfigCache = map;
  cacheTimestamp = now;
  return map;
}

/**
 * Get model config by ID.
 * Lookup: exact match first, then strip '-thinking' suffix.
 */
function getModelConfig(modelId) {
  const configs = loadModelConfigs();
  if (configs.has(modelId)) return configs.get(modelId);
  const base = modelId.replace(/-thinking$/, '');
  if (base !== modelId && configs.has(base)) return configs.get(base);
  return {
    id: modelId,
    model_multiplier: 1.0,
    output_multiplier: 5.0,
    cache_read_multiplier: 0.1,
    cache_creation_multiplier: 2.0,
  };
}

/**
 * Calculate dollar cost for a single request.
 * Base price = $2 / 1M tokens (matches relay station pricing)
 * prompt_price = base * model_multiplier
 * completion_price = prompt_price * output_multiplier
 * cache_creation_price = prompt_price * cache_creation_multiplier
 * cache_read_price = prompt_price * cache_read_multiplier
 * total = (prompt + completion + cache_creation + cache_read) * group_multiplier
 */
const BASE_PRICE_PER_M = 2.0; // $2 per 1M tokens

function calculateCost(modelId, usage, groupMultiplier = 1.0) {
  const config = getModelConfig(modelId);
  const promptPrice = BASE_PRICE_PER_M * config.model_multiplier; // e.g. opus4.6: $2 * 2.5 = $5/M

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_tokens || 0;
  const cacheReadTokens = usage.cache_read_tokens || 0;

  const promptCost = (inputTokens / 1e6) * promptPrice;
  const outputCost = (outputTokens / 1e6) * promptPrice * config.output_multiplier;
  const cacheCreationCost = (cacheCreationTokens / 1e6) * promptPrice * config.cache_creation_multiplier;
  const cacheReadCost = (cacheReadTokens / 1e6) * promptPrice * config.cache_read_multiplier;

  const rawCost = promptCost + outputCost + cacheCreationCost + cacheReadCost;
  return rawCost * (groupMultiplier || 1.0);
}

/**
 * Convert dollar amount to internal units ($0.0001 = 1 unit)
 */
function dollarToUnits(dollars) {
  return Math.round(dollars * 10000);
}

/**
 * Invalidate the model config cache (call after admin edits models)
 */
function invalidateCache() {
  modelConfigCache = null;
  cacheTimestamp = 0;
}

module.exports = { calculateCost, dollarToUnits, getModelConfig, invalidateCache };
