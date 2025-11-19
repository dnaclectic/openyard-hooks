// server.js

const express = require("express");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// ----- ENV SETUP -----
const {
  PORT,
  STRIPE_SECRET_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TELNYX_API_KEY,
  TELNYX_FROM_NUMBER,      // e.g. "+18887881978"
  BOOKING_PRICE_CENTS,     // e.g. "2500"
  STRIPE_SUCCESS_URL,      // e.g. "https://openyardpark.com/thanks?session_id={CHECKOUT_SESSION_ID}"
  STRIPE_CANCEL_URL        // e.g. "https://openyardpark.com/cancelled"
} = process.env;

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TELNYX_API_KEY || !TELNYX_FROM_NUMBER) {
  console.error("Missing one or more required env vars. Check STRIPE/TELNYX/SUPABASE configs.");
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();

// Stripe webhooks *technically* want raw body for signature verification.
// For v1 MVP, we skip signature verification and just use JSON.
app.use(express.json());

// ----- Helper: send SMS via Telnyx -----
async function sendSms(to, text) {
  try {
    const resp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: TELNYX_FROM_NUMBER,
        to,
        text
      })
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error("Telnyx sendSms error:", resp.status, body);
    }
  } catch (err) {
    console.error("Telnyx sendSms exception:", err);
  }
}

// ----- 1) Inbound SMS: /webhooks/telnyx -----
app.post("/webhooks/telnyx", async (req, res) => {
  try {
    const event = req.body;

    // Telnyx inbound example: event.data.event_type === "message.received"
    // Text is at event.data.payload.text
    const eventType = event?.data?.event_type;
    const payload = event?.data?.payload;

    if (eventType !== "message.received" || !payload) {
      // Just ack things we don't care about so Telnyx doesn't retry forever
      return res.sendStatus(200);
    }

    const fromNumber = payload.from?.phone_number;
    const messageText = (payload.text || "").trim();

    console.log("Inbound SMS from", fromNumber, "text:", messageText);

    // For now, simple trigger: text "BOOK" (case-insensitive) starts a booking
    if (messageText.toUpperCase().startsWith("BOOK")) {
      const priceCents = parseInt(BOOKING_PRICE_CENTS || "2500", 10); // default $25

      // 1) Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "Overnight Truck Parking"
              },
              unit_amount: priceCents
            },
            quantity: 1
          }
        ],
        success_url:
          STRIPE_SUCCESS_URL ||
          "https://openyardpark.com/thanks?session_id={CHECKOUT_SESSION_ID}",
        cancel_url:
          STRIPE_CANCEL_URL ||
          "https://openyardpark.com/cancelled",
        metadata: {
          phone: fromNumber || "",
          // You can add lot_id here later when you support multiple lots
        }
      });

      console.log("Created Stripe session:", session.id);

      // 2) Store booking in Supabase (pending)
      const { error } = await supabase.from("bookings").insert([
        {
          phone: fromNumber,
          status: "pending_payment",
          checkout_session_id: session.id,
          amount_cents: priceCents
          // lot_id: null for now
        }
      ]);

      if (error) {
        console.error("Supabase insert booking error:", error);
      }

      // 3) Reply to driver with payment URL
      await sendSms(
        fromNumber,
        `OpenYard: Tap to pay and reserve your spot: ${session.url}`
      );
    } else {
      // Optional: basic help response
      await sendSms(
        fromNumber,
        "OpenYard: To book overnight parking, reply with 'BOOK'."
      );
    }

    // Always ack to stop retries
    res.sendStatus(200);
  } catch (err) {
    console.error("Error in /webhooks/telnyx:", err);
    // Still 200 to avoid retry storms; log and fix instead of punishing drivers
    res.sendStatus(200);
  }
});

// ----- 2) Stripe webhook: /webhooks/stripe -----
app.post("/webhooks/stripe", async (req, res) => {
  try {
    const event = req.body;

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const checkoutId = session.id;
      const phone = session.metadata?.phone;

      console.log("Stripe checkout.session.completed:", checkoutId, phone);

      // 1) Update booking status in Supabase
      const { error } = await supabase
        .from("bookings")
        .update({ status: "confirmed" })
        .eq("checkout_session_id", checkoutId);

      if (error) {
        console.error("Supabase update booking error:", error);
      }

      // 2) Text driver confirmation
      if (phone) {
        await sendSms(
          phone,
          "OpenYard: Your booking is confirmed. Show this message if asked. (Demo: stall assignment and directions coming next.)"
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error in /webhooks/stripe:", err);
    res.sendStatus(200);
  }
});

// ----- HEALTHCHECK -----
app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// ----- START SERVER -----
const port = PORT || 3000;
app.listen(port, () => {
  console.log(`OpenYard backend listening on port ${port}`);
});
