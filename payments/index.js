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
  const line1 = (lot.address_line1 || "").trim();
  const line2 = (lot.address_line2 || "").trim();
  const city = (lot.city || "").trim();
  const state = (lot.state || "").trim();
  const zip = (lot.zip || "").trim();

  const street = [line1, line2].filter(Boolean).join(", ");
  const cityStateZip = [city, state, zip].filter(Boolean).join(" ");
  return [street, cityStateZip].filter(Boolean).join(", ").trim();
}

function hasMeaningfulAddress(address) {
  // Prevent sending vague stuff like "Frontage Rd, Bozeman MT 59715" if you consider that too weak.
  // If you want to allow any address_line1, just return Boolean(address).
  if (!address) return false;
  const a = address.toLowerCase();
  // heuristic: must contain a number OR a comma-separated street+city
  const hasNumber = /\d/.test(a);
  const hasComma = a.includes(",");
  return hasNumber || hasComma;
}

function buildGoogleMapsUrlFromQuery(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    query
  )}`;
}

function buildNavigateLink(lot) {
  // Prefer GPS coordinates for truckers (less ambiguity)
  const hasGps =
    lot &&
    lot.latitude != null &&
    lot.longitude != null &&
    Number.isFinite(Number(lot.latitude)) &&
    Number.isFinite(Number(lot.longitude));

  if (hasGps) {
    const lat = Number(lot.latitude);
    const lng = Number(lot.longitude);
    const gps = `${lat},${lng}`;
    return {
      gpsLine: `${lat}, ${lng}`,
      url: buildGoogleMapsUrlFromQuery(gps),
      used: "gps",
    };
  }

  const address = buildLotAddress(lot);
  if (address && hasMeaningfulAddress(address)) {
    return {
      gpsLine: "",
      url: buildGoogleMapsUrlFromQuery(address),
      used: "address",
    };
  }

  // last resort
  const fallback = lot?.name || lot?.lot_code || "OpenYard lot";
  return {
    gpsLine: "",
    url: buildGoogleMapsUrlFromQuery(fallback),
    used: "name",
  };
}

function formatDateRange(startDate, endDate) {
  return `${startDate} to ${endDate}`;
}

function templatePaymentLink({ lotName, lotCode, nights, totalCents, url }) {
  const dollars = Math.round(Number(totalCents) / 100);
  const lotLine = `${lotName}${lotCode ? ` (${lotCode})` : ""}`;

  return (
    "OpenYard — secure payment link\n" +
    `${lotLine}\n` +
    `${nights} night${nights === 1 ? "" : "s"} • $${dollars}\n\n` +
    `${url}\n\n` +
    "Need help? Reply SUPPORT."
  );
}

function templateConfirmation({
  lotName,
  lotCode,
  datesLine,
  plate,
  addressLine,
  navigateUrl,
  gpsLine,
  instructions,
}) {
  // Keep it clean + scannable for SMS
  const lines = [];

  lines.push("✅ Booking confirmed!");
  lines.push(`${lotName}${lotCode ? ` (${lotCode})` : ""}`);
  lines.push(`Dates: ${datesLine}`);
  if (plate) lines.push(`Plate: ${plate}`);
  lines.push("");

  if (addressLine) lines.push(`Address: ${addressLine}`);
  lines.push(`Navigate: ${navigateUrl}`);
  if (gpsLine) lines.push(`GPS: ${gpsLine}`);
  lines.push("");

  lines.push("Special instructions:");
  lines.push(instructions || "Park in marked truck stalls.");
  lines.push("");

  lines.push("Keep this text for your records.");
  lines.push("Reply SUPPORT if you need help.");

  return lines.join("\n");
}

/**
 * ✅ Service-day helpers (8am rollover)
 * If it's before 8am local server time, we treat "today" as the previous service day.
 * This avoids the "books 12/30 at 1am but start_date is 12/31" problem.
 */
function serviceDayISO({ rolloverHourLocal = 8 } = {}) {
  const now = new Date();
  const service = new Date(now);
  if (now.getHours() < rolloverHourLocal) {
    service.setDate(service.getDate() - 1);
  }

  const yyyy = service.getFullYear();
  const mm = String(service.getMonth() + 1).padStart(2, "0");
  const dd = String(service.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + Number(days || 0));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

  // ✅ FIX: 8am service-day rollover for start_date/end_date
  const startDate = serviceDayISO({ rolloverHourLocal: 8 });
  const endDate = addDaysISO(startDate, conv.nights || 1);

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
    await notifyOwnerAlert(
      `Supabase insert booking error: ${bookingErr.message}`
    );
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
    success_url:
      process.env.CHECKOUT_SUCCESS_URL || "https://openyardpark.com",
    cancel_url:
      process.env.CHECKOUT_CANCEL_URL || "https://openyardpark.com",
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

  const payMsg = templatePaymentLink({
    lotName: lot?.name || "OpenYard lot",
    lotCode: lot?.lot_code || "",
    nights: Number(conv.nights || 1),
    totalCents: pricing.total_cents,
    url: session.url,
  });

  await logSms(conv.id, conv.driver_phone_e164, "outbound", payMsg);

  return payMsg;
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
      await notifyOwnerAlert(
        "Stripe checkout.session.completed missing booking_id"
      );
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
      await notifyOwnerAlert(
        `Error loading lot for confirmation: ${lotErr.message}`
      );
    }

    const lotName = lot?.name || "OpenYard lot";
    const lotCode = lot?.lot_code || "";
    const addressRaw = lot ? buildLotAddress(lot) : "";
    const addressLine =
      addressRaw && hasMeaningfulAddress(addressRaw) ? addressRaw : "";

    const nav = lot
      ? buildNavigateLink(lot)
      : { url: "", gpsLine: "", used: "name" };
    const navigateUrl = nav.url || "https://www.google.com/maps";
    const gpsLine = nav.gpsLine || "";

    const instructions =
      lot && lot.parking_instructions
        ? lot.parking_instructions
        : "Park in marked truck stalls.";

    const confirmMsg = templateConfirmation({
      lotName,
      lotCode,
      datesLine: formatDateRange(booking.start_date, booking.end_date),
      plate: booking.license_plate_raw || "",
      addressLine,
      navigateUrl,
      gpsLine,
      instructions,
    });

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
