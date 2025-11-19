// server.js

const express = require("express");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

// ----- ENV SETUP -----
const {
  PORT,
  STRIPE_SECRET_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  BOOKING_PRICE_CENTS,
  STRIPE_SUCCESS_URL,
  STRIPE_CANCEL_URL,
  SHORTIO_API_KEY,
  SHORTIO_DOMAIN
} = process.env;

if (
  !STRIPE_SECRET_KEY ||
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_FROM_NUMBER
) {
  console.error(
    "Missing one or more required env vars. Check STRIPE/SUPABASE/TWILIO configs."
  );
}

const stripe = Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();

// Stripe webhooks want JSON; Twilio sends urlencoded.
// Use JSON globally and urlencoded only on the Twilio route.
app.use(express.json());

// ----- Helper: send SMS via Twilio -----
async function sendSms(to, body) {
  try {
    const msg = await twilioClient.messages.create({
      from: TWILIO_FROM_NUMBER,
      to,
      body
    });
    console.log("Twilio SMS sent:", msg.sid);
  } catch (err) {
    console.error("Twilio sendSms error:", err);
  }
}

// ----- Helper: Shorten URL via Short.io -----
// If SHORTIO_API_KEY or SHORTIO_DOMAIN are missing, just return the original URL.
async function shortenUrl(longUrl) {
  if (!SHORTIO_API_KEY || !SHORTIO_DOMAIN) {
    return longUrl;
  }

  try {
    const resp = await fetch("https://api.short.io/links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: SHORTIO_API_KEY
      },
      body: JSON.stringify({
        domain: SHORTIO_DOMAIN,
        originalURL: longUrl
      })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("Short.io error:", resp.status, txt);
      return longUrl;
    }

    const data = await resp.json();
    const shortUrl = data.secureShortURL || data.shortURL || longUrl;
    console.log("Short.io created link:", shortUrl);
    return shortUrl;
  } catch (err) {
    console.error("Short.io exception:", err);
    return longUrl;
  }
}

// ----- 1) Inbound SMS from Twilio: /webhooks/twilio -----
app.post(
  "/webhooks/twilio",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const start = Date.now();
    try {
      const fromNumber = req.body.From;
      const messageText = (req.body.Body || "").trim();

      console.log(
        "Twilio webhook hit at",
        new Date().toISOString(),
        "from",
        fromNumber,
        "text:",
        messageText
      );

      if (!fromNumber) {
        res.type("text/xml").send("<Response></Response>");
        return;
      }

      // For now, simple trigger: text "BOOK" starts a booking
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
            phone: fromNumber || ""
            // TODO: add lot_id, plate, etc once we build conversation flow
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

        // 3) Shorten URL (if Short.io configured)
        const paymentUrl = await shortenUrl(session.url);

        // 4) Reply to driver with payment URL
        await sendSms(
          fromNumber,
          `OpenYard: Tap to pay and reserve your spot: ${paymentUrl}`
        );
      } else {
        // Simple help message for anything else
        await sendSms(
          fromNumber,
          "OpenYard: To book overnight parking, reply with 'BOOK'."
        );
      }

      console.log(
        "Finished /webhooks/twilio in",
        Date.now() - start,
        "ms"
      );

      // Twilio expects some TwiML; empty response is fine
      res.type("text/xml").send("<Response></Response>");
    } catch (err) {
      console.error("Error in /webhooks/twilio:", err);
      // Still respond with empty TwiML so Twilio doesn't keep retrying
      res.type("text/xml").send("<Response></Response>");
    }
  }
);

// ----- 2) Stripe webhook: /webhooks/stripe -----
app.post("/webhooks/stripe", async (req, res) => {
  try {
    const event = req.body;

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const checkoutId = session.id;
      const phone = session.metadata?.phone;

      console.log(
        "Stripe checkout.session.completed:",
        checkoutId,
        phone
      );

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
