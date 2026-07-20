const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const sql = require('./_db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const playerId = parseInt(req.body && req.body.player_id, 10);
  const token = req.body && req.body.token;
  if (!playerId || !token) return res.status(401).json({ error: 'You must be logged in to play' });

  // Same non-consuming check pong-game.js's match-config uses (not token.js's
  // one-time-use verify action, which would burn the token on the first
  // purchase and break every subsequent Play Again in the session).
  const tokRows = await sql`SELECT 1 FROM game_tokens WHERE token=${token} AND user_id=${playerId}`;
  if (!tokRows.length) return res.status(401).json({ error: 'You must be logged in to play' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'paypal'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Pong — Entry Fee' },
          unit_amount: 299,
        },
        quantity: 1,
      }],
      metadata: { player_id: String(playerId), game: 'Pong', mode: 'solo' },
      success_url: 'https://all-solo-ggames.vercel.app/pong/?paid=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://all-solo-ggames.vercel.app/pong/',
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};
