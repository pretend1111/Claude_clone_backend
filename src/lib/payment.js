const crypto = require('crypto');
const config = require('../config');

/**
 * 支付适配层 — 抽象接口，具体实现可替换
 * 当前为模拟实现（Mock），接入真实支付平台时替换此文件
 */

/**
 * 创建支付订单
 * @param {Object} params - { orderId, amount, subject, paymentMethod }
 * @returns {Promise<{ payUrl: string, qrcodeUrl: string, tradeNo: string }>}
 */
async function createOrder(params) {
  const { orderId, amount, subject, paymentMethod } = params;
  // Mock: 生成模拟的支付链接和二维码
  const tradeNo = `MOCK_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  return {
    payUrl: `mock://pay?order=${orderId}&amount=${amount}&method=${paymentMethod}`,
    qrcodeUrl: `mock://qrcode?order=${orderId}`,
    tradeNo,
  };
}

/**
 * 验证回调签名
 * @param {Object} params - 回调请求的完整参数
 * @returns {boolean}
 */
function verifyCallback(params) {
  // Mock: 验证签名（真实环境需要用支付平台密钥验证）
  const appSecret = config.PAYMENT_APP_SECRET;
  if (!appSecret) return false;

  const { sign, ...rest } = params;
  if (!sign) return false;

  // 按 key 排序拼接 + appSecret，计算 HMAC-SHA256
  const sortedKeys = Object.keys(rest).sort();
  const str = sortedKeys.map(k => `${k}=${rest[k]}`).join('&') + `&key=${appSecret}`;
  const expected = crypto.createHmac('sha256', appSecret).update(str).digest('hex');
  return sign === expected;
}

/**
 * 查询订单状态
 * @param {string} tradeNo - 平台订单号
 * @returns {Promise<{ status: string }>}
 */
async function queryOrder(tradeNo) {
  // Mock: 始终返回 pending（真实环境调用支付平台查询接口）
  return { status: 'pending' };
}

module.exports = {
  createOrder,
  verifyCallback,
  queryOrder,
};
