const { Pool } = require('pg');
let _pool;
module.exports = function db() {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
};
