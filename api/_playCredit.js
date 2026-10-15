const sql = require('./_db');

// Refund Balance: a second, NON-cashable balance (users.play_credit). The game
// servers add to it when an entry was paid for a match that couldn't happen
// through no fault of the player, and spend it on a whole entry; payouts only
// ever touch the winnings balance (users.balance). This just makes sure the
// column exists before tenten.run reads it (the game servers' migration adds
// it too — same shared lock, idempotent).
const MIGRATION_LOCK = 727274;
let ready = null;

function ensurePlayCredit() {
  if (!ready) {
    ready = (async () => {
      const have = await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'play_credit'`;
      if (have.length) return;
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK})`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS play_credit NUMERIC(10,2) NOT NULL DEFAULT 0`,
      ]);
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

module.exports = { ensurePlayCredit };
