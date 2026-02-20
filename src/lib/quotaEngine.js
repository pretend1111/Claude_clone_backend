const { getDb } = require('../db/init');
const billing = require('./billing');

const WINDOW_HOURS = 5;
const WINDOW_MS = WINDOW_HOURS * 3600 * 1000;
const CYCLE_DAYS = 7.5;
const CYCLE_MS = CYCLE_DAYS * 24 * 3600 * 1000;

function toSqlite(date) {
  if (!date) return null;
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

function parseSqlite(str) {
  if (!str) return null;
  return new Date(str.replace(' ', 'T') + 'Z');
}

function getActiveSub(db, userId) {
  db.prepare(
    "UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ? AND status = 'active' AND expires_at <= datetime('now')"
  ).run(userId);
  return db.prepare(
    "SELECT s.*, p.window_budget, p.weekly_budget, p.name as plan_name " +
    "FROM user_subscriptions s LEFT JOIN plans p ON s.plan_id = p.id " +
    "WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at > datetime('now') " +
    "AND s.starts_at <= datetime('now') ORDER BY s.created_at ASC LIMIT 1"
  ).get(userId);
}

/**
 * Auto-reset window/week counters if expired
 */
function maybeResetCounters(db, sub) {
  const now = new Date();
  const updates = [];
  const values = [];

  // Window reset: >= 5h since window_start
  const windowStart = parseSqlite(sub.window_start);
  if (!windowStart || now.getTime() - windowStart.getTime() >= WINDOW_MS) {
    updates.push('window_start = ?', 'window_used = 0');
    values.push(toSqlite(now));
  }

  // Cycle reset: >= 7.5 days since week_start
  // week_start anchored to starts_at, not first request
  const weekStart = parseSqlite(sub.week_start);
  if (!weekStart) {
    // First time: anchor to subscription starts_at, find current cycle
    const startsAt = parseSqlite(sub.starts_at);
    const anchor = startsAt || now;
    // How many full cycles have passed since starts_at?
    const elapsed = now.getTime() - anchor.getTime();
    const cyclesPassed = Math.floor(elapsed / CYCLE_MS);
    const currentCycleStart = new Date(anchor.getTime() + cyclesPassed * CYCLE_MS);
    updates.push('week_start = ?', 'week_used = 0', 'bonus_used = 0');
    values.push(toSqlite(currentCycleStart));
  } else if (now.getTime() - weekStart.getTime() >= CYCLE_MS) {
    // Advance to next cycle boundary (not now, to keep aligned)
    const elapsed = now.getTime() - weekStart.getTime();
    const cyclesPassed = Math.floor(elapsed / CYCLE_MS);
    const newStart = new Date(weekStart.getTime() + cyclesPassed * CYCLE_MS);
    updates.push('week_start = ?', 'week_used = 0', 'bonus_used = 0');
    values.push(toSqlite(newStart));
  }

  if (updates.length > 0) {
    db.prepare(`UPDATE user_subscriptions SET ${updates.join(', ')} WHERE id = ?`).run(...values, sub.id);
    // Re-fetch
    return db.prepare("SELECT s.*, p.window_budget, p.weekly_budget, p.name as plan_name, p.plan_type FROM user_subscriptions s LEFT JOIN plans p ON s.plan_id = p.id WHERE s.id = ?").get(sub.id);
  }
  return sub;
}

/**
 * Calculate bonus budget from site surplus
 */
function calcBonusBudget(sub, db) {
  if (!sub.weekly_budget || sub.weekly_budget <= 0) return 0;

  // Get all active subs on the same plan
  const allSubs = db.prepare(
    "SELECT week_used, weekly_budget FROM user_subscriptions s " +
    "LEFT JOIN plans p ON s.plan_id = p.id " +
    "WHERE s.plan_id = ? AND s.status = 'active' AND s.expires_at > datetime('now')"
  ).all(sub.plan_id);

  if (allSubs.length <= 1) return 0;

  const totalBudget = allSubs.reduce((s, r) => s + (r.weekly_budget || 0), 0);
  // Predict total consumption based on cycle progress
  const weekStart = parseSqlite(sub.week_start);
  const now = new Date();
  const daysSoFar = weekStart ? Math.max(0.5, (now.getTime() - weekStart.getTime()) / (24 * 3600 * 1000)) : 1;
  const totalUsed = allSubs.reduce((s, r) => s + (r.week_used || 0), 0);
  const predictedTotal = totalUsed * (CYCLE_DAYS / daysSoFar);
  const surplus = totalBudget - predictedTotal;
  if (surplus <= 0) return 0;

  // Count users at >= 90% weekly budget
  const heavyUsers = allSubs.filter(r => r.weekly_budget > 0 && (r.week_used / r.weekly_budget) >= 0.9).length;
  if (heavyUsers <= 0) return 0;

  const perUser = surplus / heavyUsers;
  const cap = sub.weekly_budget * 0.5;
  return Math.min(perUser, cap);
}

/**
 * Check if user is allowed to make a request
 */
function checkQuota(userId) {
  const db = getDb();
  const user = db.prepare('SELECT token_used, token_quota FROM users WHERE id = ?').get(userId);
  if (!user) return { allowed: false, reason: 'NO_USER', message: '用户不存在' };

  let sub = getActiveSub(db, userId);
  if (!sub) {
    if (Number(user.token_quota) <= 0 || Number(user.token_used) >= Number(user.token_quota)) {
      return { allowed: false, reason: 'NO_SUBSCRIPTION', message: '您当前没有可用套餐，请先购买套餐后使用' };
    }
    return { allowed: true, reason: null };
  }

  // Auto-reset counters
  sub = maybeResetCounters(db, sub);

  // 1. Total quota check
  if (sub.tokens_used >= sub.token_quota) {
    return { allowed: false, reason: 'QUOTA_EXCEEDED', message: '套餐额度已用完，请升级套餐', quota: buildQuotaInfo(sub, db) };
  }

  // 2. Window check
  const windowBudget = sub.window_budget || 0;
  if (windowBudget > 0 && (sub.window_used || 0) >= windowBudget) {
    const windowStart = parseSqlite(sub.window_start);
    const resetAt = windowStart ? new Date(windowStart.getTime() + WINDOW_MS) : null;
    return {
      allowed: false, reason: 'WINDOW_EXCEEDED',
      message: `当前窗口额度已用完，请${resetAt ? '等待 ' + formatTimeRemaining(resetAt) + ' 后' : '稍后'}重试`,
      quota: buildQuotaInfo(sub, db),
    };
  }

  // 3. Weekly check
  const weeklyBudget = sub.weekly_budget || 0;
  if (weeklyBudget > 0 && (sub.week_used || 0) >= weeklyBudget) {
    // Check bonus
    const bonusBudget = calcBonusBudget(sub, db);
    if (bonusBudget <= 0 || (sub.bonus_used || 0) >= bonusBudget) {
      return {
        allowed: false, reason: 'WEEKLY_EXCEEDED',
        message: '本周期额度已用完，请等待周期重置',
        quota: buildQuotaInfo(sub, db),
      };
    }
  }

  return { allowed: true, reason: null, quota: buildQuotaInfo(sub, db) };
}

/**
 * Record usage after a request completes
 */
function recordUsage(userId, dollarCost) {
  const db = getDb();
  const dollarUnits = billing.dollarToUnits(dollarCost);
  if (dollarUnits <= 0) return 0;

  // Update user total
  db.prepare('UPDATE users SET token_used = token_used + ? WHERE id = ?').run(dollarUnits, userId);

  let sub = getActiveSub(db, userId);
  if (!sub) return dollarUnits;

  // Auto-reset counters
  sub = maybeResetCounters(db, sub);

  // Update subscription total
  db.prepare('UPDATE user_subscriptions SET tokens_used = tokens_used + ? WHERE id = ?').run(dollarUnits, sub.id);

  // Update window_used
  db.prepare('UPDATE user_subscriptions SET window_used = window_used + ? WHERE id = ?').run(dollarCost, sub.id);

  // Update week_used or bonus_used
  const weeklyBudget = sub.weekly_budget || 0;
  if (weeklyBudget <= 0 || (sub.week_used || 0) < weeklyBudget) {
    db.prepare('UPDATE user_subscriptions SET week_used = week_used + ? WHERE id = ?').run(dollarCost, sub.id);
  } else {
    db.prepare('UPDATE user_subscriptions SET bonus_used = bonus_used + ? WHERE id = ?').run(dollarCost, sub.id);
  }

  return dollarUnits;
}

/**
 * Build quota info object for frontend
 */
function buildQuotaInfo(sub, db) {
  if (!sub) return null;
  const windowStart = parseSqlite(sub.window_start);
  const windowResetAt = windowStart ? new Date(windowStart.getTime() + WINDOW_MS) : null;
  const weekStart = parseSqlite(sub.week_start);
  const weekResetAt = weekStart ? new Date(weekStart.getTime() + CYCLE_MS) : null;

  const weeklyBudget = sub.weekly_budget || 0;
  const weekUsed = sub.week_used || 0;
  const bonusBudget = (weeklyBudget > 0 && weekUsed >= weeklyBudget) ? calcBonusBudget(sub, db) : 0;
  const bonusActive = bonusBudget > 0;

  return {
    window: {
      used: sub.window_used || 0,
      limit: sub.window_budget || 0,
      resetAt: windowResetAt ? windowResetAt.toISOString() : null,
    },
    week: {
      used: weekUsed,
      limit: weeklyBudget,
      resetAt: weekResetAt ? weekResetAt.toISOString() : null,
    },
    bonus: {
      active: bonusActive,
      used: sub.bonus_used || 0,
      limit: bonusBudget,
      reason: bonusActive ? '站点盈余赠送' : '',
    },
    total: {
      used: (sub.tokens_used || 0) / 10000,
      limit: (sub.token_quota || 0) / 10000,
    },
  };
}

/**
 * Get quota info for /usage endpoint
 */
function getQuotaInfo(userId) {
  const db = getDb();
  let sub = getActiveSub(db, userId);
  if (!sub) return null;
  sub = maybeResetCounters(db, sub);
  return buildQuotaInfo(sub, db);
}

function formatTimeRemaining(targetDate) {
  const diff = targetDate.getTime() - Date.now();
  if (diff <= 0) return '即将';
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}小时${mins}分钟`;
  return `${mins}分钟`;
}

module.exports = { checkQuota, recordUsage, getQuotaInfo, calcBonusBudget };
