// server.js – OpenYard SMS Booking Backend (booking flow + debug logging)

require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const port = process.env.PORT || 3000;

// -----------------------------------------------------
// Clients
// -----------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// -----------------------------------------------------
// Global request logger (so we're never blind again)
// -----------------------------------------------------
app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url}`
  );
  next();
});

// -----------------------------------------------------
// Stripe webhook (must come BEFORE body parsers)
// -----------------------------------------------------
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  stripeWebhookHandler
);

// For everything else, use parsers
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio inbound SMS
app.post("/webhooks/twilio", twilioWebhookHandler);

// Simple root + health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "OpenYard backend" });
});

app.get("/healthz", (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

// -----------------------------------------------------
// Twilio → SMS Handler
// -----------------------------------------------------

async function twilioWebhookHandler(req, res) {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  console.log("Twilio webhook hit at", new Date().toISOString(), {
    from,
    body,
  });

  let replyText = "Sorry, something broke on our end.";

  try {
    replyText = await handleIncomingSms(from, body, req.body);
  } catch (err) {
    console.error("handleIncomingSms error:", err);
    replyText =
      "Oops, something went wrong. Try again or text HELP for assistance.";
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(replyText);

  res.type("text/xml").send(twiml.toString());
}

// -----------------------------------------------------
// Core SMS Machine
// -----------------------------------------------------

async function handleIncomingSms(phone, text, rawPayload) {
  const upper = text.toUpperCase().trim();

  // GLOBAL COMMANDS
  if (upper === "HELP") {
    return (
      "OpenYard Truck Parking.\n" +
      "Text BOOK to start a new reservation.\n" +
      "Text CANCEL to cancel your active booking."
    );
  }

  if (upper === "STOP" || upper === "CANCEL") {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, "inbound", text, rawPayload);
    return "Okay, your booking flow has been cancelled. Text BOOK to start over.";
  }

  // FETCH ACTIVE CONVERSATION
  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .eq("driver_phone_e164", phone)
    .eq("is_active", true)
    .limit(1);

  if (convErr) {
    console.error("Supabase conversations fetch error:", convErr);
  }

  let conversation = convRows && convRows[0] ? convRows[0] : null;

  // START NEW CONVERSATION
  if (!conversation) {
    if (upper !== "BOOK") {
      await logSms(null, phone, "inbound", text, rawPayload);
      return "Text BOOK to start a new truck parking reservation.";
    }

    // Create conversation
    const { data: newConv, error: newConvErr } = await supabase
      .from("conversations")
      .insert({
        driver_phone_e164: phone,
        current_state: "awaiting_location_or_lot_code",
