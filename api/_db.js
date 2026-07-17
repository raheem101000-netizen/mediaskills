const { neon } = require('@neondatabase/serverless');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
}
const sql = neon(process.env.DATABASE_URL);

module.exports = sql;
