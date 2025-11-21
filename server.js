// server.js - Minimal debug version for Twilio webhook

import express from 'express';
import bodyParser from 'body-parser';

const app = express();
const PORT = process.env.PORT || 3000;

// Log EVERY request that hits the server
app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url}`
  );
  next();
});

// Twilio sends application/x-www-form-urlencoded for SMS webhooks
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Simple health check
app.get('/healthz', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Minimal Twilio webhook just to prove traffic is flowing
app.post('/webhooks/twilio', (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  console.log('Twilio webhook hit:', { from, body });

  const reply = `OpenYard debug: I got "${body}" from ${from}.`;

  // Respond with TwiML so Twilio sends the SMS
  res.set('Content-Type', 'text/xml');
  res.send(
    `<Response><Message>${reply}</Message></Response>`
  );
});

app.listen(PORT, () => {
  console.log(`OpenYard debug backend listening on port ${PORT}`);
});
