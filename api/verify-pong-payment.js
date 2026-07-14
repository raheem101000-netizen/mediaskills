const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://all-solo-ggames.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).end();
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    res.status(200).json({ paid: session.payment_status === 'paid' });
  } catch (e) {
    console.error(e);
    res.status(200).json({ paid: false });
  }
};
