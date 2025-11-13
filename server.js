import express from "express";
import fetch from "node-fetch";
import pino from "pino";
import pinoHttp from "pino-http";
import getRawBody from "raw-body";
import Stripe from "stripe";

const {
  PORT = 3000,
  MAKE_TELNYX_URL,
  MAKE_STRIPE_URL,
  STRIPE_WEBHOOK_SECRET
} = process.env;

const stripe = new Stripe(process.env.STRIPE_SECRET || "", { apiVersion: "2024-06-20" });
const app = express();
const log = pino({ level: "info" });
app.use(pinoHttp({ logger: log }));

// Health
app.get("/healthz", (req, res) => res.json({ ok: true }));

// Inbound SMS -> forward to Make (Twilio-style form payload)
app.post(
  "/webhooks/telnyx",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    try {
      // req.body is now the Twilio-style form object (Body, From, To, etc.)
      const params = new URLSearchParams(req.body);

      log.info({ body: req.body }, "incoming sms webhook, forwarding to Make");

      // Forward to Make as application/x-www-form-urlencoded
      fetch(MAKE_TELNYX_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString()
      }).catch((err) => {
        log.error({ err }, "error forwarding sms to Make");
      });

      res.sendStatus(200);
    } catch (e) {
      log.error(e, "sms webhook error");
      res.sendStatus(200);
    }
  }
);

// Stripe -> verify sig -> forward to Make
app.post("/webhooks/stripe", async (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const raw = await getRawBody(req);
    const event = Stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);

    if (["checkout.session.completed", "payment_intent.succeeded", "charge.refunded"].includes(event.type)) {
      await fetch(MAKE_STRIPE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: event.type, data: event.data.object })
      });
    }
    res.sendStatus(200);
  } catch (e) {
    log.error(e, "stripe verify/forward failed");
    res.sendStatus(200);
  }
});

app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.listen(PORT, () => log.info({ PORT }, "openyard hooks listening"));
