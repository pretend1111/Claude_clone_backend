const jwt = require('jsonwebtoken');

const config = require('../config');

function generateToken(userId) {
  return jwt.sign({ userId }, config.JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, config.JWT_SECRET);
}

module.exports = {
  generateToken,
  verifyToken,
};

