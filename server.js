import express from 'express';
import Stripe from 'stripe';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ----------------------------
// INIT CLIENTS
// ----------------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ----------------------------
// 1. STRIPE WEBHOOK – MUST USE RAW BODY
// ----------------------------
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('❌ Stripe signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 🔥 Process Stripe event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      console.log('✅ Stripe checkout.session.completed received:', session.id);

      // 1. Update booking in Supabase
      const { data: bookingRows, error: bookingErr } = await supabase
        .from('bookings')
        .update({
          status: 'confirmed',
          paid_at: new Date().toISOString(),
          stripe_payment_intent: session.payment_intent,
          stripe_checkout_url: session.url
        })
        .eq('stripe_session_id', session.id)
        .select();

      if (bookingErr) {
        console.error('❌ Supabase update error:', bookingErr);
      } else {
        console.log('✅ Booking updated in Supabase:', bookingRows);
      }

      // 2. Send confirmation SMS
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: bookingRows[0].driver_phone_e164,
          body:
            'Your reservation is confirmed. Your payment was received. Parking instructions will follow shortly.'
        });
        console.log('📲 Confirmation SMS sent');
      } catch (smsErr) {
        console.error('❌ SMS send error:', smsErr);
      }
    }

    res.sendStatus(200); // <-- CRITICAL
  }
);

// ----------------------------
// 2. ALL OTHER ROUTES – JSON BODY
// ----------------------------
app.use(express.json());

// Webhook for Twilio inbound
app.post('/webhooks/twilio', async (req, res) => {
  console.log(
    `Twilio webhook hit at ${new Date().toISOString()} from ${req.body.From} text: ${req.body.Body}`
  );

  // (existing conversation flow handler logic here)
  // unchanged from your last working version

  res.send('<Response></Response>');
});

// Health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

// ----------------------------
// START SERVER
// ----------------------------
app.listen(port, () => {
  console.log(`🚀 OpenYard backend listening on port ${port}`);
});
