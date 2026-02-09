require('dotenv').config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const API_BASE_URL = process.env.API_BASE_URL || '';
const API_KEY = process.env.API_KEY || '';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Please set it in your .env file.');
}

module.exports = {
  PORT,
  JWT_SECRET,
  API_BASE_URL,
  API_KEY,
};

