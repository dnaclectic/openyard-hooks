// server.js – thin Express boot, routes, and health/status

import 'dotenv/config';
import express from 'express';
import { stripeWebhookHandler } from './payments/index.js';
import { twilioWebhookHandler } from './sms/handler.js';
import {
  runDueReviewMessages,
  expireIdleConversations,
} from './scheduler/index.js';
import { supabase } from './db/db.js';

const app = express();
const port = process.env.PORT || 3000;

// Stripe webhook (raw body)
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

// Body parsers for everything else
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio inbound SMS
app.post('/webhooks/twilio', twilioWebhookHandler);

// Healthcheck – also runs background tasks
app.get('/healthz', async (req, res) => {
  try {
    await expireIdleConversations(30);
    await runDueReviewMessages();
    return res.json({ ok: true });
  } catch (err) {
    console.error('healthz error:', err);
    return res.status(500).json({ ok: false });
  }
});

// Status endpoint – lightweight observability
app.get('/status', async (req, res) => {
  try {
    const nowIso = new Date().toISOString();

    const { count: activeConvosCount, error: convErr } = await supabase
      .from('conversations')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true);

    const { count: pendingScheduledCount, error: schedErr } = await supabase
      .from('scheduled_messages')
      .select('*', { count: 'exact', head: true })
      .is('sent_at', null)
      .lte('send_at', nowIso);

    return res.json({
      ok: true,
      serverTime: nowIso,
      uptimeSeconds: Math.floor(process.uptime()),
      activeConversations: convErr ? null : activeConvosCount || 0,
      dueScheduledMessages: schedErr ? null : pendingScheduledCount || 0,
    });
  } catch (err) {
    console.error('/status error:', err);
    return res.status(500).json({ ok: false, error: 'status_failed' });
  }
});

app.listen(port, () => {
  console.log(`OpenYard backend listening on port ${port}`);
});
