// payments/index.js
import "dotenv/config";
import Stripe from "stripe";
import { supabase, logSms, updateConversation } from "../db/db.js";
import {
  twilioClient,
  notifyOwnerAlert,
  computePricing,
  computeReviewSendAt,
} from "../utils/index.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

function buildLotAddress(lot) {
  if (!lot) return "";
  const line = [lot.address_line1, lot.address_line2].filter(Boolean).join(", ");
  const cityStateZip = [lot.city, lot.state, lot.zip].filter(Boolean).join(" ");
  return [line, cityStateZip].filter(Boolean).join(", ");
}

function buildGoogleMapsUrl(lot) {
  if (!lot) return "";
  const address = buildLotAddress(lot);
  const gps =
    lot.latitude != null && lot.longitude != null
      ? `${lot.latitude},${lot.longitude}`
      : "";
  const query = address || gps || lot.lot_code || lot.name || "";
  if (!query) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    query
  )}`;
}

export async function createBooking(conversation) {
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", conversation.id)
    .single();

  if (convErr) {
    console.error("Error reloading conversation for booking:", convErr);
    await notifyOwnerAlert(
      `Error reloading conversation for booking: ${convErr.message}`
    );
    return "We couldn't create your booking. Please try again.";
  }

  const { data: lot, error: lotErr } = await supabase
    .from("lots")
    .select("*")
    .eq("id", conv.lot_id)
    .single();

  if (lotErr) {
    console.error("Error loading lot for booking:", lotErr);
    await notifyOwnerAlert(`Error loading lot for booking: ${lotErr.message}`);
    return "We couldn't find that lot. Try again.";
  }

  const pricing = computePricing(lot, conv.stay_type, conv.nights);

  const today = new Date();
  const startDate = today.toISOString().slice(0, 10);
  const end = new Date(today);
  end.setDate(end.getDate() + (conv.nights || 1));
  const endDate = end.toISOString().slice(0, 10);

  const { data: booking, error: bookingErr } = await supabase
    .from("bookings")
    .insert({
      conversation_id: conv.id,
      lot_id: conv.lot_id,
      driver_phone_e164: conv.driver_phone_e164,
      driver_full_name: conv.driver_full_name,
      truck_type: conv.truck_type,
      truck_make_model: conv.truck_make_model,
      license_plate_raw: conv.license_plate_raw,
      stay_type: conv.stay_type,
      nights: conv.nights,
      start_date: startDate,
      end_date: endDate,
      nightly_rate_cents: pricing.nightly_rate_cents,
      weekly_rate_cents: lot.weekly_rate_cents,
      monthly_rate_cents: lot.monthly_rate_cents,
      subtotal_cents: pricing.subtotal_cents,
      deposit_hold_cents: pricing.deposit_hold_cents,
      total_cents: pricing.total_cents,
      currency: "usd",
      status: "pending_payment",
    })
    .select()
    .single();

  if (bookingErr) {
    console.error("Supabase insert booking error:", bookingErr);
    await notifyOwnerAlert(`Supabase insert booking error: ${bookingErr.message}`);
    return "We couldn't create your booking. Please try again.";
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: pricing.total_cents,
          product_data: {
            name: `Truck Parking – ${lot.name}`,
            description: `${conv.nights} night(s) at ${lot.name}`,
          },
        },
      },
    ],
    metadata: {
      booking_id: booking.id,
    },
    success_url: process.env.CHECKOUT_SUCCESS_URL || "https://openyardpark.com",
    cancel_url: process.env.CHECKOUT_CANCEL_URL || "https://openyardpark.com",
  });

  await supabase
    .from("bookings")
    .update({
      stripe_session_id: session.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", booking.id);

  await updateConversation(conv.id, {
    booking_id: booking.id,
    current_state: "awaiting_payment",
  });

  await logSms(conv.id, conv.driver_phone_e164, "outbound", session.url);

  return "Here’s your secure payment link:\n" + session.url;
}

export async function stripeWebhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Stripe signature error:", err.message);
    await notifyOwnerAlert(`Stripe signature error: ${err.message}`);
    return res.status(400).send("Invalid signature");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session.metadata && session.metadata.booking_id;

    if (!bookingId) {
      console.warn("Stripe: missing booking_id");
      await notifyOwnerAlert("Stripe checkout.session.completed missing booking_id");
      return res.send("ok");
    }

    const nowIso = new Date().toISOString();

    const { data: rows, error: updErr } = await supabase
      .from("bookings")
      .update({
        status: "confirmed",
        paid_at: nowIso,
        stripe_payment_intent_id: session.payment_intent,
        stripe_customer_id: session.customer,
      })
      .eq("id", bookingId)
      .select()
      .limit(1);

    if (updErr || !rows || rows.length === 0) {
      console.error("Error updating booking on payment:", updErr);
      await notifyOwnerAlert(
        `Error updating booking on payment: ${
          updErr ? updErr.message : "no rows returned"
        }`
      );
      return res.send("ok");
    }

    const booking = rows[0];

    await supabase
      .from("conversations")
      .update({
        is_active: false,
        current_state: "completed",
        updated_at: nowIso,
      })
      .eq("id", booking.conversation_id);

    const { data: lot, error: lotErr } = await supabase
      .from("lots")
      .select("*")
      .eq("id", booking.lot_id)
      .single();

    if (lotErr) {
      console.error("Error loading lot for confirmation:", lotErr);
      await notifyOwnerAlert(`Error loading lot for confirmation: ${lotErr.message}`);
    }

    const lotName = lot?.name || "OpenYard lot";
    const lotCode = lot?.lot_code || "";
    const address = buildLotAddress(lot);
    const mapsUrl = buildGoogleMapsUrl(lot);
    const gpsLine =
      lot?.latitude != null && lot?.longitude != null
        ? `GPS: ${lot.latitude}, ${lot.longitude}\n`
        : "";
    const instructions =
      lot && lot.parking_instructions
        ? lot.parking_instructions
        : "Park in marked truck stalls.";

    const header = `✅ Confirmed — you’re booked at ${lotName}${
      lotCode ? ` (${lotCode})` : ""
    }\n\n`;

    const confirmMsg =
      header +
      (address ? `Address: ${address}\n` : "") +
      (mapsUrl ? `Maps: ${mapsUrl}\n` : "") +
      gpsLine +
      `Dates: ${booking.start_date} to ${booking.end_date}\n` +
      `Plate: ${booking.license_plate_raw}\n\n` +
      `Special instructions:\n${instructions}\n\n` +
      "Keep this text as your receipt.\n" +
      "Need help? Reply SUPPORT\n" +
      "Cancel? Reply CANCEL";

    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: booking.driver_phone_e164,
      body: confirmMsg,
    });

    await logSms(
      booking.conversation_id,
      booking.driver_phone_e164,
      "outbound",
      confirmMsg
    );

    const sendAtIso = computeReviewSendAt(lot);
    const driverName = booking.driver_full_name || null;

    await supabase.from("scheduled_messages").insert({
      booking_id: booking.id,
      lot_id: booking.lot_id,
      driver_phone_e164: booking.driver_phone_e164,
      driver_full_name: driverName,
      message_type: "review_nudge",
      send_at: sendAtIso,
    });
  }

  res.send("ok");
}
```0
