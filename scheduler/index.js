import { supabase, logSms } from "../db/db.js";
import { twilioClient, notifyOwnerAlert } from "../utils/index.js";

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
  if (!address) return false;
  const a = address.toLowerCase();
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

  const fallback = lot?.name || lot?.lot_code || "OpenYard lot";
  return {
    gpsLine: "",
    url: buildGoogleMapsUrlFromQuery(fallback),
    used: "name",
  };
}

export async function runDueReviewMessages() {
  const nowIso = new Date().toISOString();

  const { data: due, error: dueErr } = await supabase
    .from("scheduled_messages")
    .select("*")
    .is("sent_at", null)
    .lte("send_at", nowIso)
    .limit(10);

  if (dueErr) {
    console.error("Error fetching scheduled messages:", dueErr);
    await notifyOwnerAlert(
      `Error fetching scheduled messages: ${dueErr.message}`
    );
    return;
  }

  if (!due || due.length === 0) return;

  for (const msg of due) {
    try {
      const { data: lot, error: lotErr } = await supabase
        .from("lots")
        .select(
          "name, lot_code, region_label, review_url, address_line1, address_line2, city, state, zip, latitude, longitude"
        )
        .eq("id", msg.lot_id)
        .single();

      if (lotErr) {
        console.error("Error loading lot for review nudge:", msg.id, lotErr);
        await notifyOwnerAlert(
          `Error loading lot for review nudge (msg ${msg.id}): ${lotErr.message}`
        );
      }

      const reviewUrl = lot && lot.review_url ? lot.review_url : null;

      if (!reviewUrl) {
        await supabase
          .from("scheduled_messages")
          .update({
            sent_at: new Date().toISOString(),
            last_error: "no review_url on lot",
          })
          .eq("id", msg.id);
        continue;
      }

      // Fetch booking to get conversation_id and status
      const { data: bookingRows, error: bookingErr } = await supabase
        .from("bookings")
        .select("conversation_id,status")
        .eq("id", msg.booking_id)
        .limit(1);

      if (bookingErr || !bookingRows || bookingRows.length === 0) {
        console.error(
          "Error loading booking for review nudge:",
          msg.id,
          bookingErr
        );
        await notifyOwnerAlert(
          `Error loading booking for review nudge (msg ${msg.id}): ${
            bookingErr ? bookingErr.message : "not found"
          }`
        );
        await supabase
          .from("scheduled_messages")
          .update({
            sent_at: new Date().toISOString(),
            last_error: "booking not found",
          })
          .eq("id", msg.id);
        continue;
      }

      const booking = bookingRows[0];

      // Only send review if booking is confirmed
      if (booking.status !== "confirmed") {
        await supabase
          .from("scheduled_messages")
          .update({
            sent_at: new Date().toISOString(),
            last_error: `skipped: booking status = ${booking.status}`,
          })
          .eq("id", msg.id);
        continue;
      }

      let firstName = "driver";
      if (msg.driver_full_name) {
        firstName = msg.driver_full_name.trim().split(/\s+/)[0] || "driver";
      }

      const lotName = lot?.name || "OpenYard lot";
      const lotCode = lot?.lot_code ? ` (${lot.lot_code})` : "";

      const nav = lot ? buildNavigateLink(lot) : { url: "", gpsLine: "", used: "name" };
      const navigateUrl = nav.url || "";

      // Keep it short (review requests should be tight)
      const body =
        `Hey ${firstName} — quick favor? ` +
        `If you have 15 seconds, please leave a review for ${lotName}${lotCode}. ` +
        (navigateUrl ? `Navigate: ${navigateUrl} ` : "") +
        `Review: ${reviewUrl} ` +
        `Safe travels.`;

      await twilioClient.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: msg.driver_phone_e164,
        body,
      });

      await supabase
        .from("scheduled_messages")
        .update({
          sent_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", msg.id);

      await logSms(
        booking.conversation_id,
        msg.driver_phone_e164,
        "outbound",
        body
      );
    } catch (err) {
      console.error("Error sending scheduled message", msg.id, err);
      await notifyOwnerAlert(
        `Error sending scheduled message ${msg.id}: ${err.message}`
      );
      await supabase
        .from("scheduled_messages")
        .update({
          last_error: err.message,
        })
        .eq("id", msg.id);
    }
  }
}

export async function expireIdleConversations(maxMinutes = 30) {
  const cutoffIso = new Date(Date.now() - maxMinutes * 60 * 1000).toISOString();

  const { error } = await supabase
    .from("conversations")
    .update({
      is_active: false,
      current_state: "expired",
      updated_at: new Date().toISOString(),
    })
    .eq("is_active", true)
    .lte("last_inbound_at", cutoffIso);

  if (error) {
    console.error("Error expiring idle conversations:", error);
  }
}
