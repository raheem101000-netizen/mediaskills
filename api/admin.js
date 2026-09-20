const sql = require('./_db');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const ADMIN_KEY = 'TENTEN2025';
const PONG_CYCLE_LENGTH = 20;
const PONG_WIN_PAYOUT = 5.00;

async function listUsers(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  // purchases/total_spent are windowed to "since last_payout_at" (or lifetime, if the user
  // has never been paid out) so they cover the same period as balance, which resets to 0
  // on payout. See markPayoutPaid.
  const rows = await sql`
    SELECT u.id, u.display_name, u.email, u.balance, u.paypal_email, u.created_at, u.last_payout_at,
           COUNT(s.id) FILTER (WHERE u.last_payout_at IS NULL OR s.created_at > u.last_payout_at) AS purchases,
           COALESCE(SUM(s.amount) FILTER (WHERE u.last_payout_at IS NULL OR s.created_at > u.last_payout_at), 0) AS total_spent
    FROM users u
    LEFT JOIN sessions s ON s.user_id = u.id
    GROUP BY u.id
    ORDER BY u.balance DESC
  `;
  res.status(200).json(rows.map(r => ({
    id: r.id, display_name: r.display_name, email: r.email, balance: r.balance,
    paypal_email: r.paypal_email, created_at: r.created_at, last_payout_at: r.last_payout_at,
    purchases: parseInt(r.purchases, 10), total_spent: parseFloat(r.total_spent)
  })));
}

async function salesStats(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const totals = await sql`SELECT COUNT(*) AS total_sales, COALESCE(SUM(amount),0) AS total_revenue FROM sessions`;
  const byGame = await sql`SELECT game, mode, COUNT(*) AS sales, SUM(amount) AS revenue FROM sessions GROUP BY game, mode ORDER BY revenue DESC`;
  res.status(200).json({
    total_sales: parseInt(totals[0].total_sales, 10),
    total_revenue: parseFloat(totals[0].total_revenue),
    breakdown: byGame.map(r => ({
      game: r.game,
      mode: r.mode,
      sales: parseInt(r.sales, 10),
      revenue: parseFloat(r.revenue)
    }))
  });
}

async function listSessions(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { game, mode } = req.query;
  let rows;
  if (game && mode) {
    rows = await sql`
      SELECT id, game, mode, amount, stripe_payment_id, user_id, created_at
      FROM sessions WHERE game = ${game} AND mode = ${mode} ORDER BY created_at ASC
    `;
  } else {
    rows = await sql`
      SELECT id, game, mode, amount, stripe_payment_id, user_id, created_at
      FROM sessions ORDER BY created_at ASC
    `;
  }
  res.status(200).json(rows.map(r => ({
    id: r.id, game: r.game, mode: r.mode,
    amount: parseFloat(r.amount), stripe_payment_id: r.stripe_payment_id, user_id: r.user_id, created_at: r.created_at
  })));
}

async function inspectCheckoutSession(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { pi } = req.query;
  if (!pi) return res.status(400).json({ error: 'Missing pi (payment_intent id)' });
  const list = await stripe.checkout.sessions.list({ payment_intent: pi, limit: 1 });
  const session = list.data[0];
  if (!session) return res.status(404).json({ error: 'No checkout session found for that payment_intent' });
  res.status(200).json({
    id: session.id,
    payment_intent: session.payment_intent,
    amount_total: session.amount_total,
    metadata: session.metadata,
    created: new Date(session.created * 1000).toISOString(),
  });
}

async function inspectPayment(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { pi } = req.query;
  if (!pi) return res.status(400).json({ error: 'Missing pi (payment_intent id)' });
  const intent = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge'] });
  res.status(200).json({
    id: intent.id,
    amount: intent.amount,
    amount_received: intent.amount_received,
    currency: intent.currency,
    description: intent.description,
    metadata: intent.metadata,
    created: new Date(intent.created * 1000).toISOString(),
    latest_charge_description: intent.latest_charge && intent.latest_charge.description,
    latest_charge_amount: intent.latest_charge && intent.latest_charge.amount,
  });
}

async function deleteSessions(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const idsParam = req.body && req.body.ids;
  if (!Array.isArray(idsParam) || !idsParam.length) return res.status(400).json({ error: 'Missing ids array' });
  const ids = idsParam.map(n => parseInt(n, 10));
  if (ids.some(n => !Number.isInteger(n))) return res.status(400).json({ error: 'ids must be integers' });
  // Deletes ONLY the exact row ids passed in — no criteria-based matching,
  // so this can't accidentally sweep up unrelated or future legitimate rows.
  const rows = await sql`DELETE FROM sessions WHERE id = ANY(${ids}) RETURNING id, game, mode, amount, stripe_payment_id`;
  res.status(200).json({ deleted_count: rows.length, deleted: rows });
}

async function listGameTokens(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const userId = parseInt(req.query.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'Missing user_id' });
  const rows = await sql`
    SELECT token, user_id, created_at, expires_at, used
    FROM game_tokens WHERE user_id = ${userId} ORDER BY created_at DESC
  `;
  res.status(200).json(rows);
}

// Diagnostic-only, read-only: raw game_wins rows for a player, with stripe_payment_id and
// credited_at, so a win can be joined back to the exact sessions row that funded it instead
// of guessing from timing alone.
async function listGameWins(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const userId = parseInt(req.query.player_id, 10);
  if (!userId) return res.status(400).json({ error: 'Missing player_id' });
  const rows = await sql`
    SELECT player_id, game, match_number, stripe_payment_id, credited_at
    FROM game_wins WHERE player_id = ${userId} ORDER BY credited_at ASC NULLS LAST, match_number ASC
  `;
  res.status(200).json(rows);
}

async function resetPongCycle(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const before = await sql`SELECT player_id, match_position FROM player_game_state WHERE game = 'pong' ORDER BY player_id`;
  const updated = await sql`UPDATE player_game_state SET match_position = 0 WHERE game = 'pong' RETURNING player_id, match_position`;
  const after = await sql`SELECT player_id, match_position FROM player_game_state WHERE game = 'pong' ORDER BY player_id`;
  res.status(200).json({
    rows_before: before,
    rows_affected: updated.length,
    rows_after: after,
  });
}

async function deleteUsers(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const idsParam = req.body && req.body.ids;
  if (!Array.isArray(idsParam) || !idsParam.length) return res.status(400).json({ error: 'Missing ids array' });
  const ids = idsParam.map(n => parseInt(n, 10));
  if (ids.some(n => !Number.isInteger(n))) return res.status(400).json({ error: 'ids must be integers' });
  // Clear FK-dependent rows for the SAME exact id list first (still no criteria-based
  // matching — every statement here is scoped to the ids the caller passed in).
  await sql`DELETE FROM game_tokens WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM auth_sessions WHERE user_id = ANY(${ids})`;
  await sql`DELETE FROM player_game_state WHERE player_id = ANY(${ids})`;
  await sql`DELETE FROM game_wins WHERE player_id = ANY(${ids})`;
  const rows = await sql`DELETE FROM users WHERE id = ANY(${ids}) RETURNING id, display_name, email`;
  res.status(200).json({ deleted_count: rows.length, deleted: rows });
}

async function addUserIdColumn(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id)`;
  res.status(200).json({ ok: true });
}

// One-off, idempotent migration: adds the timestamp markPayoutPaid stamps so "spend since
// last payout" has a dated anchor to count from. Nullable by design — a user who has never
// been paid out (or was paid out before this column existed) stays NULL, which listUsers
// treats as "sum from the beginning," not backfilled with a guessed date.
async function addLastPayoutAtColumn(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_payout_at TIMESTAMPTZ`;
  res.status(200).json({ ok: true });
}

// One-off, idempotent migration: adds the marker that distinguishes an actual pending
// payout request from just "has a saved paypal_email and a positive balance" (the bug
// payoutRequests used to key on — a user stays in that state forever once they've ever
// entered a paypal_email, whether or not they've asked to be paid recently). Nullable by
// design — every existing row starts NULL, i.e. "no active request," until update-payout
// sets it; markPayoutPaid clears it back to NULL once paid.
async function addPayoutRequestedAtColumn(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_requested_at TIMESTAMPTZ`;
  res.status(200).json({ ok: true });
}

// One-off, idempotent migration: adds the column record-win will dedupe wins on
// (Stripe payment_intent instead of match_number, which repeats after a cycle reset).
// Nullable by design — legacy game_wins rows stay NULL here rather than being backfilled
// with a guessed payment attribution; NULLs never collide in a unique index.
async function addGameWinsPaymentColumn(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await sql`ALTER TABLE game_wins ADD COLUMN IF NOT EXISTS stripe_payment_id TEXT`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS game_wins_stripe_payment_id_key ON game_wins (stripe_payment_id)`;
  res.status(200).json({ ok: true });
}

// One-off, idempotent migration: creates the match_results audit table — one row per
// match END, win or loss, written unconditionally by the server so a match outcome is
// never unverifiable again (this is what we couldn't answer when investigating a
// disputed win — no record existed of the attempt at all, only of a successful credit).
// stripe_payment_id is nullable by design: if it's ever missing at write time we still
// want the row (player/tier/outcome/timestamp) rather than losing the record entirely —
// a NULL payment_id is itself a visible signal worth investigating, not a reason to drop
// the row. No CHECK on tier since it's meant to be shared across games with different
// tier vocabularies (Pong: EASY/MEDIUM/SUPER; Kurver: EASY/SUPER).
async function migrateMatchResults(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await sql`
    CREATE TABLE IF NOT EXISTS match_results (
      id                 SERIAL PRIMARY KEY,
      player_id          INTEGER NOT NULL,
      game               TEXT NOT NULL,
      stripe_payment_id  TEXT,
      outcome            TEXT NOT NULL CHECK (outcome IN ('win','loss')),
      tier               TEXT NOT NULL,
      match_number       INTEGER NOT NULL,
      credited           BOOLEAN NOT NULL DEFAULT false,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS match_results_payment_unique
    ON match_results (stripe_payment_id) WHERE stripe_payment_id IS NOT NULL
  `;
  res.status(200).json({ ok: true });
}

// One-off, idempotent migration: creates the balance_ledger table — one row per balance
// mutation (win credit, manual credit, or payout), with balance_before/balance_after
// captured at the moment of the write. Nothing before this migration is backfilled —
// pre-existing balance changes have no recoverable before/after, and fabricating one
// would be worse than admitting the gap. stripe_payment_id is nullable (a payout event
// has no single payment_intent behind it); match_number is nullable for the same reason.
async function migrateBalanceLedger(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  await sql`
    CREATE TABLE IF NOT EXISTS balance_ledger (
      id                 SERIAL PRIMARY KEY,
      player_id          INTEGER NOT NULL REFERENCES users(id),
      game               TEXT,
      match_number       INTEGER,
      reason             TEXT NOT NULL CHECK (reason IN ('win_credit', 'manual_credit', 'payout')),
      delta              NUMERIC NOT NULL,
      balance_before     NUMERIC NOT NULL,
      balance_after      NUMERIC NOT NULL,
      stripe_payment_id  TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS balance_ledger_player_id_idx ON balance_ledger (player_id)`;
  res.status(200).json({ ok: true });
}

// One-off migration: fixes two win-crediting bugs found together in the same 500 —
// (1) game_wins' composite PK on (player_id, game, match_number) collides once
// match_number recycles through the 20-position cycle, even for a brand-new payment;
// stripe_payment_id (already unique, already what recordWin's ON CONFLICT targets) is
// the real uniqueness guarantee, so the composite PK is dropped and replaced with a
// surrogate serial id. The legacy rows with stripe_payment_id IS NULL are left exactly
// as they are — this only changes the PK, it never touches a column value.
// (2) match_results' existing unique index is PARTIAL (WHERE stripe_payment_id IS NOT
// NULL), which Postgres can't use as an ON CONFLICT (stripe_payment_id) arbiter — an
// inference target must match an index's predicate exactly. Swapped for a plain UNIQUE
// constraint (verified beforehand: zero duplicate non-null stripe_payment_id rows exist,
// so this is safe to add outright).
// Runs as a single non-interactive transaction (sql.transaction) so either both land or
// neither does. Before/after snapshots are returned so the caller can verify nothing was
// dropped or duplicated without a separate round trip.
async function fixWinCreditingConstraints(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const beforeCount = (await sql`SELECT COUNT(*)::int AS n FROM game_wins`)[0].n;
  const beforeNullRows = await sql`
    SELECT player_id, game, match_number, credited_at FROM game_wins
    WHERE stripe_payment_id IS NULL ORDER BY player_id, game, match_number
  `;

  await sql.transaction([
    sql`ALTER TABLE game_wins DROP CONSTRAINT game_wins_pkey`,
    sql`ALTER TABLE game_wins ADD COLUMN id SERIAL PRIMARY KEY`,
    sql`DROP INDEX IF EXISTS match_results_payment_unique`,
    sql`ALTER TABLE match_results ADD CONSTRAINT match_results_payment_unique UNIQUE (stripe_payment_id)`,
  ]);

  const afterCount = (await sql`SELECT COUNT(*)::int AS n FROM game_wins`)[0].n;
  const afterNullRows = await sql`
    SELECT player_id, game, match_number, credited_at FROM game_wins
    WHERE stripe_payment_id IS NULL ORDER BY player_id, game, match_number
  `;

  const gameWinsConstraints = await sql`
    SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'game_wins'
  `;
  const matchResultsConstraints = await sql`
    SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'match_results'
  `;

  res.status(200).json({
    ok: true,
    game_wins_row_count_before: beforeCount,
    game_wins_row_count_after: afterCount,
    row_count_unchanged: beforeCount === afterCount,
    legacy_null_rows_before: beforeNullRows,
    legacy_null_rows_after: afterNullRows,
    legacy_rows_untouched: JSON.stringify(beforeNullRows) === JSON.stringify(afterNullRows),
    game_wins_constraints: gameWinsConstraints,
    match_results_constraints: matchResultsConstraints,
  });
}

// Manual-recovery path for a genuine win that recordWin failed to credit (e.g. the
// match_number-collision bug, or a future 403 from webhook-timing lag). Deliberately
// mirrors recordWin's own logic — sessions cross-check + dedupe on stripe_payment_id —
// so a manual credit is exactly as safe as a normal one and can never double-pay the
// same payment_intent even if run twice by mistake. match_number here is descriptive
// only; must be a value not already used by that player (the original PK still applies).
async function manualCreditWin(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const playerId = parseInt(req.body && req.body.player_id, 10);
  const game = req.body && req.body.game;
  const matchNumber = parseInt(req.body && req.body.match_number, 10);
  const paymentIntent = req.body && req.body.payment_intent;
  if (!playerId || game !== 'pong' || !matchNumber || !paymentIntent) {
    return res.status(400).json({ error: 'Missing or invalid params' });
  }

  const before = await sql`SELECT balance FROM users WHERE id = ${playerId}`;
  if (!before.length) return res.status(404).json({ error: 'User not found' });

  const paidRows = await sql`
    SELECT 1 FROM sessions WHERE stripe_payment_id = ${paymentIntent} AND user_id = ${playerId} AND game = 'Pong' AND mode = 'solo'
  `;
  if (!paidRows.length) return res.status(403).json({ error: 'No matching payment found for this player' });

  const claim = await sql`
    INSERT INTO game_wins (player_id, game, match_number, stripe_payment_id)
    VALUES (${playerId}, ${game}, ${matchNumber}, ${paymentIntent})
    ON CONFLICT (stripe_payment_id) DO NOTHING RETURNING *
  `;
  if (!claim.length) {
    return res.status(200).json({
      ok: true, credited: 0, note: 'already credited',
      balance_before: parseFloat(before[0].balance).toFixed(2),
      balance_after: parseFloat(before[0].balance).toFixed(2),
    });
  }

  const after = await sql`UPDATE users SET balance = balance + ${PONG_WIN_PAYOUT} WHERE id = ${playerId} RETURNING balance`;
  await sql`
    INSERT INTO balance_ledger (player_id, game, match_number, reason, delta, balance_before, balance_after, stripe_payment_id)
    VALUES (${playerId}, ${game}, ${matchNumber}, 'manual_credit', ${PONG_WIN_PAYOUT}, ${before[0].balance}, ${after[0].balance}, ${paymentIntent})
  `;
  res.status(200).json({
    ok: true, credited: PONG_WIN_PAYOUT,
    balance_before: parseFloat(before[0].balance).toFixed(2),
    balance_after: parseFloat(after[0].balance).toFixed(2),
  });
}

// Diagnostic-only, read-only: every win match_results has on record that never got
// credited — the reconciliation list of who's owed money, with payment_intent as proof.
async function listUnclaimedWins(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const rows = await sql`
    SELECT player_id, game, stripe_payment_id, tier, match_number, created_at
    FROM match_results
    WHERE outcome = 'win' AND credited = false
    ORDER BY created_at ASC
  `;
  res.status(200).json(rows);
}

// Diagnostic-only, read-only: raw match_results rows, most recent first, optionally
// scoped to one player — lets us confirm every match END (win or loss) is actually being
// logged post-deploy, rather than inferring it indirectly from game_wins/list-unclaimed-wins.
async function listMatchResults(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const playerId = req.query.player_id ? parseInt(req.query.player_id, 10) : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = playerId
    ? await sql`
        SELECT id, player_id, game, stripe_payment_id, outcome, tier, match_number, credited, created_at
        FROM match_results WHERE player_id = ${playerId} ORDER BY created_at DESC LIMIT ${limit}
      `
    : await sql`
        SELECT id, player_id, game, stripe_payment_id, outcome, tier, match_number, credited, created_at
        FROM match_results ORDER BY created_at DESC LIMIT ${limit}
      `;
  res.status(200).json(rows);
}

const KNOWN_TABLES = ['users', 'sessions', 'game_tokens', 'player_game_state', 'game_wins', 'auth_sessions', 'match_results', 'balance_ledger'];
async function tableSchema(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { table } = req.query;
  if (!KNOWN_TABLES.includes(table)) return res.status(400).json({ error: 'Unknown table' });
  const cols = await sql`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = ${table}
    ORDER BY ordinal_position
  `;
  res.status(200).json(cols);
}

// Diagnostic-only, read-only: reports actual constraint/index definitions for a table
// so we can confirm what a unique constraint actually covers instead of guessing.
async function tableConstraints(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { table } = req.query;
  if (!KNOWN_TABLES.includes(table)) return res.status(400).json({ error: 'Unknown table' });
  const constraints = await sql`
    SELECT tc.constraint_name, tc.constraint_type,
           string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = ${table}
    GROUP BY tc.constraint_name, tc.constraint_type
  `;
  const indexes = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ${table}`;
  res.status(200).json({ constraints, indexes });
}

async function payoutRequests(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  // Filters on an actual request (payout_requested_at set), not "has paypal_email and a
  // positive balance" — the latter stays true forever once a user has ever entered a
  // paypal_email, regardless of whether they've asked to be paid recently.
  const rows = await sql`
    SELECT id, display_name, email, balance, paypal_email, created_at
    FROM users WHERE payout_requested_at IS NOT NULL ORDER BY balance DESC
  `;
  res.status(200).json(rows);
}

async function markPayoutPaid(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const userId = parseInt(req.body && req.body.user_id, 10);
  if (!userId) return res.status(400).json({ error: 'Missing user_id' });

  const before = await sql`SELECT balance FROM users WHERE id = ${userId}`;
  if (!before.length) return res.status(404).json({ error: 'User not found' });

  // Single statement, so the zero-out, the new anchor timestamp, and clearing the request
  // flag all commit atomically — there's no window where balance reads 0 against a stale
  // last_payout_at, or where a paid-out user still shows as having an active request.
  const rows = await sql`
    UPDATE users SET balance = 0, last_payout_at = NOW(), payout_requested_at = NULL
    WHERE id = ${userId} RETURNING id, last_payout_at
  `;
  // The amount actually paid is whatever balance was before this zeroed it — logged here
  // because this UPDATE is the only place that number ever existed; a payout has no
  // stripe_payment_id (it isn't a single Stripe charge), so that column stays NULL.
  await sql`
    INSERT INTO balance_ledger (player_id, game, match_number, reason, delta, balance_before, balance_after, stripe_payment_id)
    VALUES (${userId}, NULL, NULL, 'payout', ${-before[0].balance}, ${before[0].balance}, 0, NULL)
  `;
  res.status(200).json({ ok: true, last_payout_at: rows[0].last_payout_at });
}

// Dispute-grade, read-only detail view for one user: every entry charge, every logged
// match (win/loss), every balance-ledger event, and every payout — merged into one
// timeline. Never edits anything. Two honesty rules throughout: (1) a match_results row
// with credited=false is shown as a red flag, never silently hidden; (2) any balance
// change or payout that predates the balance_ledger table (or the ledger table not
// existing yet) is labeled "no ledger data on record" rather than backfilled with a
// guess — see migrateBalanceLedger's comment for why.
async function userDetail(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const userId = parseInt(req.query.id, 10);
  if (!userId) return res.status(400).json({ error: 'Missing id' });

  const userRows = await sql`
    SELECT id, email, display_name, balance, paypal_email, created_at, last_payout_at, payout_requested_at
    FROM users WHERE id = ${userId}
  `;
  if (!userRows.length) return res.status(404).json({ error: 'User not found' });
  const user = userRows[0];

  // These four are independent of each other (only the merge logic below needs all of
  // them together), so they run concurrently instead of stacking their latency — on a
  // cold Neon connection each query alone can take several seconds, and this endpoint
  // was measured at 22-24s when they ran sequentially versus 2-4s warm.
  const [sessions, matchResults, legacyWinsRaw, ledgerResult, earliestMatchResultRows] = await Promise.all([
    sql`
      SELECT id, game, mode, amount, stripe_payment_id, created_at
      FROM sessions WHERE user_id = ${userId} ORDER BY created_at ASC
    `,
    sql`
      SELECT id, game, stripe_payment_id, outcome, tier, match_number, credited, created_at
      FROM match_results WHERE player_id = ${userId} ORDER BY created_at DESC
    `,
    sql`
      SELECT player_id, game, match_number, stripe_payment_id, credited_at
      FROM game_wins WHERE player_id = ${userId} ORDER BY credited_at DESC
    `,
    // balance_ledger may not exist yet if migrate-balance-ledger hasn't been run —
    // degrade to "no ledger data" instead of a 500, since that's a real, expected
    // deployment state (code and migration are intentionally applied as separate,
    // approved steps).
    sql`
      SELECT id, game, match_number, reason, delta, balance_before, balance_after, stripe_payment_id, created_at
      FROM balance_ledger WHERE player_id = ${userId} ORDER BY created_at DESC
    `.catch(() => null),
    // Global (not per-player) moment outcome logging began — match_results didn't exist
    // before this, and game_wins never logged losses at any point, so an entry with no
    // outcome dated before this instant is a known blind spot, not a broken charge.
    // Verified against real data: every "no outcome" entry before this exact timestamp
    // for an existing user turned out to be a genuine pre-audit-era game, confirmed both
    // against game_wins (no match) and Stripe (real captured charges, not failed/auth-only).
    sql`SELECT MIN(created_at) AS earliest FROM match_results`,
  ]);
  const ledgerAvailable = ledgerResult !== null;
  const ledger = ledgerResult || [];
  const outcomeLoggingStartedAt = earliestMatchResultRows[0] && earliestMatchResultRows[0].earliest;

  // Legacy wins from before match_results existed (or before a given win was ever
  // migrated) have no reliable link to match_results — only include game_wins rows whose
  // payment isn't already represented there, so a modern win never shows up twice.
  const matchResultPaymentIds = new Set(matchResults.map(r => r.stripe_payment_id).filter(Boolean));
  const legacyWins = legacyWinsRaw.filter(w => !w.stripe_payment_id || !matchResultPaymentIds.has(w.stripe_payment_id));

  const ledgerByPaymentId = new Map(ledger.filter(l => l.stripe_payment_id).map(l => [l.stripe_payment_id, l]));
  const sessionByPaymentId = new Map(sessions.filter(s => s.stripe_payment_id).map(s => [s.stripe_payment_id, s]));

  // ── Game log: match_results rows (modern, has tier + win/loss) + legacy game_wins-only
  // rows (pre-audit, win-only, no tier) — merged and sorted newest first.
  const gameLog = [];
  for (const m of matchResults) {
    const entrySession = m.stripe_payment_id ? sessionByPaymentId.get(m.stripe_payment_id) : null;
    const ledgerRow = m.stripe_payment_id ? ledgerByPaymentId.get(m.stripe_payment_id) : null;
    gameLog.push({
      source: 'match_results',
      timestamp: m.created_at,
      game: m.game,
      tier: m.tier,
      outcome: m.outcome,
      match_number: m.match_number,
      stripe_payment_id: m.stripe_payment_id,
      entry_fee: entrySession ? parseFloat(entrySession.amount) : null,
      credited: m.outcome === 'win' ? m.credited : null,
      ledger_available: !!ledgerRow,
      balance_before: ledgerRow ? parseFloat(ledgerRow.balance_before) : null,
      balance_after: ledgerRow ? parseFloat(ledgerRow.balance_after) : null,
      payout_amount: ledgerRow ? parseFloat(ledgerRow.delta) : (m.outcome === 'win' && m.credited ? PONG_WIN_PAYOUT : 0),
    });
  }
  for (const w of legacyWins) {
    gameLog.push({
      source: 'legacy_game_wins',
      timestamp: w.credited_at,
      game: w.game,
      tier: null,
      outcome: 'win',
      match_number: w.match_number,
      stripe_payment_id: w.stripe_payment_id,
      entry_fee: null,
      credited: true, // a game_wins row only ever exists because a credit already happened
      ledger_available: false,
      balance_before: null,
      balance_after: null,
      payout_amount: PONG_WIN_PAYOUT,
    });
  }
  gameLog.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // ── Payouts: ledger-recorded events (exact amount, exact before/after) + a single
  // undated legacy marker if last_payout_at is set but predates every ledger payout row
  // (i.e., the payout happened before this table existed, so its amount is unrecoverable).
  const ledgerPayouts = ledger
    .filter(l => l.reason === 'payout')
    .map(l => ({
      timestamp: l.created_at,
      amount: Math.abs(parseFloat(l.delta)),
      balance_before: parseFloat(l.balance_before),
      balance_after: parseFloat(l.balance_after),
      status: 'paid',
      method: 'PayPal',
      processor_reference: user.paypal_email || null,
      source: 'balance_ledger',
    }));
  const payouts = [...ledgerPayouts];
  // markPayoutPaid writes last_payout_at and its balance_ledger row in the same request,
  // so a real ledger-covered payout always lands within a few seconds of last_payout_at.
  // No match that close means this payout predates the ledger entirely.
  const hasLedgerPayoutNearLastPayout = user.last_payout_at && ledgerPayouts.some(
    p => Math.abs(new Date(p.timestamp) - new Date(user.last_payout_at)) < 5000
  );
  if (user.last_payout_at && !hasLedgerPayoutNearLastPayout) {
    payouts.push({
      timestamp: user.last_payout_at,
      amount: null,
      balance_before: null,
      balance_after: null,
      status: 'paid',
      method: 'PayPal',
      processor_reference: user.paypal_email || null,
      source: 'legacy_last_payout_at',
      note: 'Amount not recorded (pre-ledger)',
    });
  }
  if (user.payout_requested_at) {
    payouts.unshift({
      timestamp: user.payout_requested_at,
      amount: parseFloat(user.balance),
      balance_before: null,
      balance_after: null,
      status: 'pending',
      method: 'PayPal',
      processor_reference: user.paypal_email || null,
      source: 'payout_requested_at',
    });
  }
  payouts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // ── Needs-attention flags
  const winsNotCredited = matchResults.filter(m => m.outcome === 'win' && !m.credited);
  // An entry with no match_results row AND no game_wins row could mean the game never
  // completed - OR it could just predate outcome logging entirely (match_results didn't
  // exist yet, and game_wins never logged losses, ever). Only the former is a real red
  // flag; the latter is a known, honest gap, not evidence of a broken charge.
  const sessionsWithNoOutcome = sessions.filter(s => s.stripe_payment_id && !matchResultPaymentIds.has(s.stripe_payment_id) && !legacyWins.some(w => w.stripe_payment_id === s.stripe_payment_id));
  const entriesNeverCompleted = sessionsWithNoOutcome.filter(s => outcomeLoggingStartedAt && new Date(s.created_at) >= new Date(outcomeLoggingStartedAt));
  const entriesPreOutcomeLogging = sessionsWithNoOutcome.filter(s => !outcomeLoggingStartedAt || new Date(s.created_at) < new Date(outcomeLoggingStartedAt));

  // ── Summary
  const wins = matchResults.filter(m => m.outcome === 'win').length + legacyWins.length;
  const losses = matchResults.filter(m => m.outcome === 'loss').length;
  const gamesPlayed = wins + losses;
  const totalEntries = sessions.reduce((sum, s) => sum + parseFloat(s.amount), 0);
  const totalPayoutsRecorded = ledgerPayouts.reduce((sum, p) => sum + p.amount, 0);

  res.status(200).json({
    user: {
      id: user.id, email: user.email, display_name: user.display_name,
      balance: parseFloat(user.balance), paypal_email: user.paypal_email,
      created_at: user.created_at,
    },
    summary: {
      games_played: gamesPlayed, wins, losses,
      win_rate: gamesPlayed ? wins / gamesPlayed : null,
      total_entries_paid: totalEntries,
      total_payouts_recorded: totalPayoutsRecorded,
      // last_payout_at is a single scalar on users (not a real history), so this can
      // only ever be 0 or 1 today - counted rather than a bare boolean so the UI reads
      // as "N earlier payouts" and stays correct if payout history is ever backfilled.
      undated_legacy_payout_count: payouts.filter(p => p.source === 'legacy_last_payout_at').length,
      net_position_recorded_only: totalPayoutsRecorded - totalEntries,
    },
    needs_attention: {
      wins_not_credited: winsNotCredited.map(m => ({ match_number: m.match_number, tier: m.tier, stripe_payment_id: m.stripe_payment_id, created_at: m.created_at })),
      entries_never_completed: entriesNeverCompleted.map(s => ({ id: s.id, amount: parseFloat(s.amount), stripe_payment_id: s.stripe_payment_id, created_at: s.created_at })),
      pending_payout: user.payout_requested_at ? { requested_at: user.payout_requested_at, amount: parseFloat(user.balance) } : null,
      failed_payouts_note: 'This system has no automated payout processor — payouts are manual PayPal transfers with no failure/status feedback, so "failed" is not a trackable state here.',
    },
    // Not a red flag: entries charged before outcome logging existed, with no result on
    // record anywhere (checked both match_results and game_wins). Shown separately so
    // nothing about a user's history is silently hidden, without implying anything is
    // actually wrong with these charges.
    entries_predating_outcome_logging: {
      outcome_logging_started_at: outcomeLoggingStartedAt,
      entries: entriesPreOutcomeLogging.map(s => ({ id: s.id, amount: parseFloat(s.amount), stripe_payment_id: s.stripe_payment_id, created_at: s.created_at })),
    },
    game_log: gameLog,
    payouts,
    ledger_available: ledgerAvailable,
  });
}

async function playerReport(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const playerId = parseInt(req.query.player_id, 10);
  if (!playerId) return res.status(400).json({ error: 'Missing player_id' });

  const userRows = await sql`SELECT id, display_name, email, balance FROM users WHERE id = ${playerId}`;
  if (!userRows.length) return res.status(404).json({ error: 'User not found' });

  const purchaseRows = await sql`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total
    FROM sessions WHERE game = 'Pong' AND mode = 'solo' AND user_id = ${playerId}
  `;
  const stateRows = await sql`
    SELECT match_position, updated_at FROM player_game_state WHERE player_id = ${playerId} AND game = 'pong'
  `;
  const winRows = await sql`
    SELECT match_number FROM game_wins WHERE player_id = ${playerId} AND game = 'pong' ORDER BY match_number
  `;

  const balance = parseFloat(userRows[0].balance);
  const winCount = winRows.length;
  const winsExpectedBalance = winCount * PONG_WIN_PAYOUT;

  res.status(200).json({
    player_id: playerId,
    display_name: userRows[0].display_name,
    email: userRows[0].email,
    games_purchased: parseInt(purchaseRows[0].cnt, 10),
    total_paid: parseFloat(purchaseRows[0].total),
    match_position: stateRows.length ? stateRows[0].match_position : null,
    cycle_number: stateRows.length ? Math.floor(stateRows[0].match_position / PONG_CYCLE_LENGTH) : null,
    slot_in_cycle: stateRows.length ? stateRows[0].match_position % PONG_CYCLE_LENGTH : null,
    games_won: winCount,
    won_match_numbers: winRows.map(r => r.match_number),
    balance,
    wins_times_5: winsExpectedBalance,
    balance_matches_wins: Math.abs(balance - winsExpectedBalance) < 0.001,
  });
}

const ACTIONS = {
  'player-report': playerReport,
  'list-users': listUsers,
  'sales-stats': salesStats,
  'list-sessions': listSessions,
  'inspect-payment': inspectPayment,
  'inspect-checkout-session': inspectCheckoutSession,
  'delete-sessions': deleteSessions,
  'delete-users': deleteUsers,
  'reset-pong-cycle': resetPongCycle,
  'list-game-tokens': listGameTokens,
  'list-game-wins': listGameWins,
  'add-user-id-column': addUserIdColumn,
  'add-last-payout-at-column': addLastPayoutAtColumn,
  'add-payout-requested-at-column': addPayoutRequestedAtColumn,
  'add-game-wins-payment-column': addGameWinsPaymentColumn,
  'manual-credit-win': manualCreditWin,
  'migrate-match-results': migrateMatchResults,
  'migrate-balance-ledger': migrateBalanceLedger,
  'user-detail': userDetail,
  'fix-win-crediting-constraints': fixWinCreditingConstraints,
  'list-unclaimed-wins': listUnclaimedWins,
  'list-match-results': listMatchResults,
  'table-schema': tableSchema,
  'table-constraints': tableConstraints,
  'payout-requests': payoutRequests,
  'mark-paid': markPayoutPaid,
};

module.exports = async function handler(req, res) {
  if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const fn = ACTIONS[req.query.action];
  if (!fn) return res.status(400).json({ error: 'Unknown action' });
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
