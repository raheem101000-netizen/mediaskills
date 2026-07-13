const { Pool } = require('pg');
let _pool;
module.exports = function db() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL is not set');
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  }
  return _pool;
};
