// sms/states/index.js
import "dotenv/config";
import { supabase, updateConversation, logSms } from "../../db/db.js";
import { computePricing, notifyOwnerAlert } from "../../utils/index.js";
import { formatDateRange } from "../../utils/lotLinks.js";

// Commands footer – used only on first prompt and summary
export function withCommandsFooter(mainText) {
  const commandsBlock =
    "\n\nCommands:\n" + "BOOK = new booking\n" + "SUPPORT = help";

  return mainText + commandsBlock;
}

/**
 * Parse location input into either:
 * - lot code / slug exact match candidate (raw)
 * - city + optional state (supports multi-word cities)
 *
 * Examples:
 *  "Bozeman MT"
 *  "Kansas City MO"
 *  "Los Angeles CA"
 *  "kcmo-01" (lot code)
 */
function parseCityState(raw) {
  const cleaned = String(raw || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return { city: null, state: null };

  const parts = cleaned.split(" ");
  if (parts.length === 1) return { city: cleaned, state: null };

  // If last token looks like a 2-letter state code, treat it as state
  const last = parts[parts.length - 1];
  const state = /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null;

  const city = state ? parts.slice(0, -1).join(" ") : cleaned;
  return { city: city.trim() || null, state };
}

async function findLotsByCodeOrSlug(raw) {
  const slugCandidate = String(raw || "").toLowerCase().replace(/\s+/g, "-");

  const { data, error } = await supabase
    .from("lots")
    .select("*")
    .eq("is_active", true)
    .or(`lot_code.ilike.${raw},slug.ilike.${slugCandidate}`);

  if (error) console.error("Error fetching lots (slug/code):", error);
  return data || [];
}

async function findLotsByCityState(city, state) {
  let q = supabase.from("lots").select("*").eq("is_active", true);

  if (city) q = q.ilike("city", `${city}%`);
  if (state) q = q.ilike("state", `${state}%`);

  const { data, error } = await q;
  if (error) console.error("Error fetching lots (city/state):", error);

  return data || [];
}

async function getStallsLeftToday(lotId) {
  try {
    const { data, error } = await supabase.rpc("openyard_stalls_left", {
      p_lot_id: lotId,
      p_date: null, // let the function compute "today" in the lot timezone
    });

    if (error) {
      console.error("RPC openyard_stalls_left error:", error);
      return null; // treat as unknown, don't hard-block
    }

    // Supabase RPC returns the scalar directly in `data`
    const n = Number(data);
    if (!Number.isFinite(n)) return null;
    return n;
  } catch (err) {
    console.error("getStallsLeftToday exception:", err);
    return null;
  }
}

function soldOutMessage(lotName) {
  return (
    `⚠️ ${lotName || "That lot"} is sold out tonight.\n\n` +
    "Reply with another city/state to see nearby lots, or text BOOK to start over."
  );
}

export async function handleLocationState(conversation, text) {
  const raw = String(text || "").trim();

  await updateConversation(conversation.id, { location_raw_input: raw });

  // 1) Try code/slug match first
  let lots = await findLotsByCodeOrSlug(raw);

  // 2) If none, try city/state (supports multi-word city names)
  if (!lots || lots.length === 0) {
    const { city, state } = parseCityState(raw);
    if (city) lots = await findLotsByCityState(city, state);
  }

  if (!lots || lots.length === 0) {
    return (
      "I couldn't find any lots near that.\n" +
      'Try a city and state (e.g. "Bozeman MT" or "Kansas City MO").'
    );
  }

  // SINGLE LOT
  if (lots.length === 1) {
    const lot = lots[0];

    // Stall gate (Option A: only nightly/today matters)
    const stallsLeft = await getStallsLeftToday(lot.id);
    if (stallsLeft !== null && stallsLeft <= 0) {
      return soldOutMessage(lot.name);
    }

    await updateConversation(conversation.id, {
      lot_id: lot.id,
      current_state: "awaiting_name",
    });

    const suffix =
      stallsLeft !== null ? `\nStalls left tonight: ${stallsLeft}` : "";

    return (
      `You’re booking: ${lot.name}${
        lot.region_label ? " – " + lot.region_label : ""
      }.${suffix}\n\n` + "What’s your first and last name?"
    );
  }

  // MULTIPLE LOTS
  const limited = lots.slice(0, 5);
  const lines = limited.map(
    (lot, i) =>
      `${i + 1}) ${lot.name}${lot.region_label ? " – " + lot.region_label : ""}`
  );

  await updateConversation(conversation.id, {
    current_state: "awaiting_lot_choice",
  });

  return "I found these lots:\n" + lines.join("\n") + "\n\nReply with a number.";
}

export async function handleLotChoiceState(conversation, text) {
  const n = parseInt(String(text || "").trim(), 10);
  if (Number.isNaN(n) || n < 1) {
    return "Reply with a valid number from the list.";
  }

  const input = conversation.location_raw_input || "";
  const { city, state } = parseCityState(input);

  // Re-fetch using the same city/state logic (most common for multi-lot results)
  let lots = [];
  if (city) lots = await findLotsByCityState(city, state);

  // Fallback to code/slug search if city/state fails (edge cases)
  if (!lots || lots.length === 0) lots = await findLotsByCodeOrSlug(input);

  const limited = (lots || []).slice(0, 5);
  if (n > limited.length) return "Please choose a valid number.";

  const chosen = limited[n - 1];

  // Stall gate (Option A: only nightly/today matters)
  const stallsLeft = await getStallsLeftToday(chosen.id);
  if (stallsLeft !== null && stallsLeft <= 0) {
    return soldOutMessage(chosen.name);
  }

  await updateConversation(conversation.id, {
    lot_id: chosen.id,
    current_state: "awaiting_name",
  });

  const suffix =
    stallsLeft !== null ? `\nStalls left tonight: ${stallsLeft}` : "";

  return (
    `You’re booking: ${chosen.name}${
      chosen.region_label ? " – " + chosen.region_label : ""
    }.${suffix}\n\n` + "What’s your first and last name?"
  );
}

export async function handleNameState(conversation, text) {
  const full = String(text || "").trim();
  if (!full || full.length < 2) return "Please send your full name.";

  await updateConversation(conversation.id, {
    driver_full_name: full,
    current_state: "awaiting_truck_type",
  });

  return (
    "What are you parking?\n" +
    "1 = Semi\n" +
    "2 = Bobtail\n" +
    "3 = Hotshot\n" +
    "4 = Other\n" +
    "Reply with a number."
  );
}

export async function handleTruckTypeState(conversation, text) {
  const n = parseInt(String(text || "").trim(), 10);
  const types = {
    1: "semi",
    2: "bobtail",
    3: "hotshot",
    4: "other",
  };
  const truckType = types[n];
  if (!truckType) return "Reply 1, 2, 3, or 4.";

  await updateConversation(conversation.id, {
    truck_type: truckType,
    current_state: "awaiting_make_model",
  });

  return 'Truck make & model? (e.g. "Freightliner Cascadia")';
}

export async function handleMakeModelState(conversation, text) {
  const v = String(text || "").trim();
  if (!v || v.length < 2) return "Please send truck make & model.";

  await updateConversation(conversation.id, {
    truck_make_model: v,
    current_state: "awaiting_plate",
  });

  return 'Plate (state + number)? (e.g. "MT 7-XYZ456")';
}

export async function handlePlateState(conversation, text) {
  const v = String(text || "").trim();
  if (!v || v.length < 2) return "Please send a valid license plate.";

  await updateConversation(conversation.id, {
    license_plate_raw: v,
    current_state: "awaiting_stay_option",
  });

  return (
    "How long are you staying?\n" +
    "1 = 1 night\n" +
    "2 = 7 nights\n" +
    "3 = 30 nights\n" +
    "4 = Other\n" +
    "Reply with a number."
  );
}

export async function handleStayOptionState(conversation, text) {
  const n = parseInt(String(text || "").trim(), 10);
  if (![1, 2, 3, 4].includes(n)) return "Reply 1–4.";

  let stayType;
  let nights;

  if (n === 1) {
    stayType = "overnight";
    nights = 1;
  } else if (n === 2) {
    stayType = "weekly";
    nights = 7;
  } else if (n === 3) {
    stayType = "monthly";
    nights = 30;
  } else {
    await updateConversation(conversation.id, {
      current_state: "awaiting_custom_nights",
    });
    return "How many nights?";
  }

  await updateConversation(conversation.id, {
    stay_type: stayType,
    nights,
    current_state: "awaiting_summary_confirmation",
  });

  return buildSummaryPrompt(conversation.id, stayType, nights);
}

export async function handleCustomNightsState(conversation, text) {
  const n = parseInt(String(text || "").trim(), 10);
  if (Number.isNaN(n) || n < 1 || n > 90) return "Enter 1–90 nights.";

  await updateConversation(conversation.id, {
    stay_type: "custom",
    nights: n,
    current_state: "awaiting_summary_confirmation",
  });

  return buildSummaryPrompt(conversation.id, "custom", n);
}

export async function buildSummaryPrompt(conversationId, stayType, nights) {
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .single();

  if (convErr) {
    console.error("Error loading conversation for summary:", convErr);
    await notifyOwnerAlert(
      `Error loading conversation for summary: ${convErr.message}`
    );
    return "We couldn't build your summary. Try again in a moment or text SUPPORT for help.";
  }

  const { data: lot, error: lotErr } = await supabase
    .from("lots")
    .select("*")
    .eq("id", conv.lot_id)
    .single();

  if (lotErr) {
    console.error("Error loading lot for summary:", lotErr);
    await notifyOwnerAlert(`Error loading lot for summary: ${lotErr.message}`);
    return "We couldn't load the lot details. Try again shortly or text SUPPORT for help.";
  }

  const pricing = computePricing(lot, stayType, nights);
  const totalDollars = (pricing.total_cents / 100).toFixed(2);

  await updateConversation(conversationId, {
    quoted_total_cents: pricing.total_cents,
  });

  return withCommandsFooter(
    "Here’s your booking:\n" +
      `• Lot: ${lot.name}${lot.region_label ? " – " + lot.region_label : ""}\n` +
      `• Name: ${conv.driver_full_name}\n` +
      `• Truck: ${conv.truck_type} – ${conv.truck_make_model}\n` +
      `• Plate: ${conv.license_plate_raw}\n` +
      `• Stay: ${nights} night(s)\n` +
      `• Total: $${totalDollars}\n\n` +
      "Reply YES to get your payment link, or NO to cancel."
  );
}

export async function handleSummaryConfirmState(conversation, text) {
  const upper = String(text || "").trim().toUpperCase();

  if (upper === "NO" || upper === "N") {
    await updateConversation(conversation.id, {
      current_state: "cancelled",
      is_active: false,
    });
    return "No problem, booking cancelled.";
  }

  if (!(upper === "YES" || upper === "Y")) {
    return "Reply YES to get your payment link, or NO to cancel.";
  }

  // createBooking is handled in payments module; handler will call it.
  return null;
}

export async function handleAwaitingPaymentState(conversation, trimmedUpper) {
  const wantsLink = ["LINK", "PAY", "PAYMENT", "YES", "Y", "RESEND"].includes(
    trimmedUpper
  );

  if (!wantsLink) {
    return (
      "Your payment link was already sent.\n" +
      "Complete payment to confirm, or text RESET to start over."
    );
  }

  if (!conversation.booking_id) {
    return (
      "We tried to find your payment link but ran into an issue.\n" +
      "Text RESET to start a fresh booking."
    );
  }

  const { data: bookingRows, error: bookingErr } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", conversation.booking_id)
    .limit(1);

  if (bookingErr || !bookingRows || bookingRows.length === 0) {
    console.error("Error loading booking in awaiting_payment:", bookingErr);
    await notifyOwnerAlert(
      `Error loading booking in awaiting_payment: ${
        bookingErr ? bookingErr.message : "not found"
      }`
    );
    return (
      "We hit a snag trying to find your payment.\n" +
      "Your card has not been charged. Text RESET to start over."
    );
  }

  const booking = bookingRows[0];

  if (booking.status === "confirmed") {
    return (
      "Your booking is already confirmed and paid.\n" +
      `Dates: ${formatDateRange(booking.start_date, booking.end_date)}\n` +
      `Plate: ${booking.license_plate_raw}`
    );
  }

  if (booking.status !== "pending_payment" || !booking.stripe_session_id) {
    return (
      "We could not re-open your payment link.\n" +
      "Text RESET to start a new booking."
    );
  }

  try {
    const stripeSessionId = booking.stripe_session_id;
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
    });

    const session = await stripe.checkout.sessions.retrieve(stripeSessionId);
    if (!session || !session.url) {
      return (
        "We could not re-open your payment link.\n" +
        "Text RESET to start a new booking."
      );
    }

    await logSms(
      booking.conversation_id,
      booking.driver_phone_e164,
      "outbound",
      session.url
    );

    return "Here’s your secure payment link:\n" + session.url;
  } catch (err) {
    console.error("Error retrieving Stripe session for resend:", err);
    await notifyOwnerAlert(
      `Error retrieving Stripe session for resend: ${err.message}`
    );
    return (
      "We had trouble re-opening your payment link.\n" +
      "Your card has not been charged. Text RESET to start over."
    );
  }
}
