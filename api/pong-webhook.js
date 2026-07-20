const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sql = require('./_db');

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // player_id is only present in metadata for logged-in players (create-pong-checkout.js
      // omits it entirely for guests), so guest purchases will have a null user_id.
      const rawPlayerId = session.metadata && session.metadata.player_id;
      const userId = rawPlayerId ? parseInt(rawPlayerId, 10) : null;
      // Unique index on stripe_payment_id makes this safe against Stripe's
      // at-least-once webhook delivery (duplicate events won't double-log revenue).
      await sql`
        INSERT INTO sessions (game, mode, amount, stripe_payment_id, user_id)
        VALUES (${'Pong'}, ${'solo'}, ${(session.amount_total || 299) / 100}, ${session.payment_intent}, ${userId})
        ON CONFLICT (stripe_payment_id) DO NOTHING
      `;
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  res.status(200).json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
