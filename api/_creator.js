const cookie = require('cookie');
const sql = require('./_db');

// Creator dashboard figures, served as GET /api/creator (vercel.json routes it
// to auth-misc?action=creator: Vercel's Hobby plan allows 12 functions and
// this would be the 13th, so it rides on an existing one, like logout/token).
// POST /api/creator asks for a payout of REIMBURSABLE ("Cashable now"): it
// only writes a 'requested' row to creator_reimbursements — nothing is paid or
// credited here; an admin pays by PayPal by hand and marks the row paid
// (admin.js creator-mark-paid), like winnings payouts. Nothing here charges,
// pays or moves money. The creator is derived ONLY from the session cookie — no creator_id
// or user_id is ever read from the request, so nobody can read another
// creator's numbers by changing a parameter.
//
// Lifetime, one dollar pool across all games, from settled_matches (one row
// per paid match) and only where entries_charged = true — until entry charging
// exists every figure is honestly 0.
//   SPENT        the creator's own entries in charged matches
//   RECOVERED    margin of charged matches with ≥1 player this creator referred
//                (match within 90 days of that player's referred_at); Kurver
//                only from 4 players; a match with players from several
//                creators is split evenly between them
//   REIMBURSABLE min(SPENT, RECOVERED) − already reimbursed (requested + paid)
//   COMMISSION   20% of profit on those matches, excluding the creator's own
//                matches; profit = margin − fees (no fee data yet: fees = 0,
//                shown "before fees")
const COMMISSION_RATE = 0.20;
const DEFAULT_TYPICAL_MARGIN_CENTS = 98;   // a $5 Pong/FIFA match, when there's no history yet

// Dollars (NUMERIC string) → whole cents, rounded down (never over-credit a split).
const cents = v => Math.floor(Math.round(parseFloat(v || 0) * 1e6) / 1e4);
const dollars = c => (Math.max(0, c) / 100).toFixed(2);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  const sid = cookie.parse(req.headers.cookie || '').session;
  if (!sid) return res.status(401).json({ error: 'Not logged in' });
  try {
    const sessions = await sql`SELECT user_id FROM auth_sessions WHERE id = ${sid} AND expires_at > NOW()`;
    if (!sessions.length) return res.status(401).json({ error: 'Session expired' });
    const userId = sessions[0].user_id;

    const creators = await sql`SELECT id, referral_code FROM creators WHERE user_id = ${userId} AND active`;
    if (!creators.length) return req.method === 'POST' ? res.status(403).json({ error: 'Not a creator' }) : res.status(200).json({ creator: false });
    const creatorId = creators[0].id;

    const fig = await creatorFigures(creatorId, userId);
    const { f, spent, recovered, reimbursable, gap, commission, typical } = fig;
    const [openRequest] = await sql`
      SELECT id, amount, requested_at FROM creator_reimbursements
       WHERE creator_id = ${creatorId} AND status = 'requested' LIMIT 1`;

    if (req.method === 'POST') {
      return requestPayout(req, res, { userId, creatorId, reimbursable, reimbursedSeen: f.reimbursed, openRequest });
    }
    const [me] = await sql`SELECT paypal_email FROM users WHERE id = ${userId}`;

    res.status(200).json({
      creator: true,
      referral_code: creators[0].referral_code,
      referral_link: 'https://tenten.run/?ref=' + creators[0].referral_code,
      referred_players: f.referred_players,
      community_matches: f.community_matches,
      charged_activity: spent > 0 || recovered > 0 || f.community_matches > 0,
      spent: dollars(spent),
      recovered: dollars(recovered),
      gap: dollars(gap),
      matches_to_go: gap > 0 ? Math.ceil(gap / typical) : 0,
      reimbursable: dollars(reimbursable),
      commission: dollars(commission),
      commission_before_fees: true,
      open_request: openRequest ? { amount: dollars(cents(openRequest.amount)), requested_at: openRequest.requested_at } : null,
      paypal_email: (me && me.paypal_email) || ''
    });
  } catch (e) {
    console.error('[creator]', e);
    res.status(500).json({ error: 'Server error' });
  }
};

// Ask for a payout of Cashable now. The amount is the server's own figure —
// never one sent by the page. Three guards keep the same money from being
// requested twice:
//   1. an open request already → refused (the dashboard shows "Payout requested");
//   2. the row is only written if the already-reimbursed total is still the
//      one this amount was worked out from (it only ever grows), so a request
//      that raced another request + payment can't add the same money again;
//   3. the table's unique index allows one 'requested' row per creator, so two
//      requests at the same moment can't both be written.
// The creator's PayPal email (where the admin sends it) is kept on their
// account, as a winnings payout request does — without making it a winnings
// request (payout_requested_at is untouched).
async function requestPayout(req, res, { userId, creatorId, reimbursable, reimbursedSeen, openRequest }) {
  if (openRequest) return res.status(409).json({ error: 'You already have a payout request open.', open_request: true });
  if (reimbursable <= 0) return res.status(400).json({ error: 'Nothing to cash out yet.' });
  const paypal = String((req.body && req.body.paypal_email) || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypal) || paypal.length > 254) {
    return res.status(400).json({ error: 'Enter the PayPal email we should pay.' });
  }
  await sql`UPDATE users SET paypal_email = ${paypal} WHERE id = ${userId}`;
  let rows;
  try {
    rows = await sql`
      INSERT INTO creator_reimbursements (creator_id, amount, status)
      SELECT ${creatorId}, ${dollars(reimbursable)}::numeric, 'requested'
       WHERE (SELECT COALESCE(SUM(amount), 0) FROM creator_reimbursements
               WHERE creator_id = ${creatorId} AND status IN ('requested', 'paid')) = ${String(reimbursedSeen)}::numeric
      RETURNING id, amount, requested_at`;
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'You already have a payout request open.', open_request: true });
    throw e;
  }
  if (!rows.length) return res.status(409).json({ error: 'Your figures just changed — refresh and try again.' });
  console.info('[creator] payout requested: creator %d, $%s (request %d)', creatorId, rows[0].amount, rows[0].id);
  res.status(200).json({ ok: true, request: { id: rows[0].id, amount: dollars(cents(rows[0].amount)), requested_at: rows[0].requested_at } });
}

// The dashboard's figures for one creator — the single source for both the
// creator dashboard (above) and the admin creator list (admin.js), so the two
// can never disagree. Charged, counted matches only (see the top of this file).
async function creatorFigures(creatorId, userId) {
  const [f] = await sql`
    WITH credited AS (
      SELECT DISTINCT sm.match_key, u.referred_by_creator_id AS creator_id
        FROM settled_matches sm
        JOIN settled_match_players p ON p.match_key = sm.match_key
        JOIN users u ON u.id = p.user_id
       WHERE sm.entries_charged
         AND (sm.game <> 'kurver' OR sm.paying_players >= 4)
         AND u.referred_by_creator_id IS NOT NULL
         AND sm.settled_at >= u.referred_at
         AND sm.settled_at < u.referred_at + interval '90 days'
    ),
    shares AS (
      SELECT match_key, creator_id, 1.0 / COUNT(*) OVER (PARTITION BY match_key) AS share FROM credited
    ),
    mine AS (
      SELECT sm.margin,
             0::numeric AS fees,   -- Stripe fees per match, once that data exists
             s.share,
             EXISTS (SELECT 1 FROM settled_match_players p WHERE p.match_key = sm.match_key AND p.user_id = ${userId}) AS i_played
        FROM shares s JOIN settled_matches sm ON sm.match_key = s.match_key
       WHERE s.creator_id = ${creatorId}
    )
    SELECT
      (SELECT COALESCE(SUM(sm.entry_price), 0)
         FROM settled_matches sm JOIN settled_match_players p ON p.match_key = sm.match_key
        WHERE p.user_id = ${userId} AND sm.entries_charged)                                   AS spent,
      (SELECT COALESCE(SUM(margin * share), 0) FROM mine)                                     AS recovered,
      (SELECT COALESCE(SUM((margin - fees) * share) FILTER (WHERE NOT i_played), 0) FROM mine) AS commission_base,
      (SELECT AVG(margin) FROM mine)                                                          AS typical_margin,
      (SELECT COUNT(*) FROM mine)::int                                                        AS community_matches,
      (SELECT COALESCE(SUM(amount), 0) FROM creator_reimbursements
        WHERE creator_id = ${creatorId} AND status IN ('requested', 'paid'))                  AS reimbursed,
      (SELECT COUNT(*) FROM users WHERE referred_by_creator_id = ${creatorId})::int           AS referred_players
  `;

  const spent = cents(f.spent), recovered = cents(f.recovered), reimbursed = cents(f.reimbursed);
  // Cashable now: money back up to what was spent, minus everything already
  // asked for or paid (requested + paid rows), so the same money can't be
  // requested twice.
  const reimbursable = Math.max(0, Math.min(spent, recovered) - reimbursed);
  const gap = Math.max(0, spent - recovered);
  const commission = Math.floor(cents(f.commission_base) * COMMISSION_RATE);
  const typical = f.typical_margin !== null && cents(f.typical_margin) > 0 ? cents(f.typical_margin) : DEFAULT_TYPICAL_MARGIN_CENTS;
  return { f, spent, recovered, reimbursed, reimbursable, gap, commission, typical };
}
module.exports.creatorFigures = creatorFigures;
module.exports.dollars = dollars;
