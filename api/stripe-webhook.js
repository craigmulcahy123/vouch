const Stripe = require('stripe');
const admin = require('firebase-admin');

// Firebase Admin is initialised lazily using a service account JSON stored as a
// Vercel environment variable (FIREBASE_SERVICE_ACCOUNT_KEY).
let _db = null;
function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    const key = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    if (!key) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY env var not set');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(key)) });
  }
  _db = admin.firestore();
  return _db;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    return res.status(400).json({ error: 'Could not read request body' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  console.log(`[stripe-webhook] received event: ${event.type}`);

  try {
    const db = getDb();

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, planKey, billingPeriod } = session.metadata || {};

      if (!userId || !planKey) {
        console.warn('[stripe-webhook] checkout.session.completed: missing metadata', session.metadata);
        return res.status(200).json({ received: true });
      }

      await db.collection('users').doc(userId).set({
        plan: planKey,
        billingPeriod: billingPeriod || null,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        planUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      console.log(`[stripe-webhook] ✅ upgraded userId=${userId} → plan=${planKey} (${billingPeriod})`);
    }

    else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const { userId } = subscription.metadata || {};

      if (!userId) {
        console.warn('[stripe-webhook] subscription.deleted: no userId in metadata, subscription id:', subscription.id);
        return res.status(200).json({ received: true });
      }

      await db.collection('users').doc(userId).set({
        plan: 'free',
        billingPeriod: null,
        stripeSubscriptionId: null,
        planUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      console.log(`[stripe-webhook] ✅ downgraded userId=${userId} → free`);
    }

    else {
      console.log(`[stripe-webhook] unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ received: true });
}

// Stripe requires the raw body for signature verification — disable Vercel's body parser.
handler.config = { api: { bodyParser: false } };
module.exports = handler;
