#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/**
 * 自动发货脚本 — 调用管理接口生成兑换码
 *
 * 用法：
 *   node scripts/auto-deliver.js --plan 3 --count 1 --note "闲鱼订单12345"
 *
 * 环境变量（或在下方常量中配置）：
 *   API_URL      — 后端地址，默认 http://localhost:3001
 *   ADMIN_API_KEY — 管理员密钥
 */

const API_URL = process.env.API_URL || 'http://localhost:3001';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plan' && args[i + 1]) opts.plan_id = Number(args[++i]);
    else if (args[i] === '--count' && args[i + 1]) opts.count = Number(args[++i]);
    else if (args[i] === '--note' && args[i + 1]) opts.note = args[++i];
    else if (args[i] === '--expires-days' && args[i + 1]) opts.expires_days = Number(args[++i]);
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`用法: node scripts/auto-deliver.js --plan <plan_id> --count <数量> [--note <备注>] [--expires-days <天数>]`);
      console.log(`\n示例: node scripts/auto-deliver.js --plan 3 --count 1 --note "闲鱼订单12345"`);
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  if (!opts.plan_id) {
    console.error('错误: 请指定 --plan <plan_id>');
    process.exit(1);
  }
  if (!opts.count || opts.count < 1) {
    opts.count = 1;
  }

  const key = ADMIN_API_KEY;
  if (!key) {
    console.error('错误: 请设置 ADMIN_API_KEY 环境变量');
    process.exit(1);
  }

  const body = {
    plan_id: opts.plan_id,
    count: opts.count,
  };
  if (opts.note) body.note = opts.note;
  if (opts.expires_days) body.expires_days = opts.expires_days;

  try {
    const res = await fetch(`${API_URL}/api/admin/redemption/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': key,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`请求失败 (${res.status}):`, data.error || data);
      process.exit(1);
    }

    console.log(`\n批次号: ${data.batch_id}`);
    console.log(`生成 ${data.codes.length} 个兑换码:\n`);
    data.codes.forEach((code, i) => {
      console.log(`  ${i + 1}. ${code}`);
    });
    console.log('');
  } catch (err) {
    console.error('请求出错:', err.message);
    process.exit(1);
  }
}

main();
