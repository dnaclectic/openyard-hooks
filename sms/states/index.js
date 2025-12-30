// sms/states/index.js
import "dotenv/config";
import { supabase, updateConversation, logSms } from "../../db/db.js";
import { notifyOwnerAlert } from "../../utils/index.js";
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
 */
function parseCityState(raw) {
  const cleaned = String(raw || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return { city: null, state: null };

  const parts = cleaned.split(" ");
  if (parts.length === 1) return { city: cleaned, state: null };

  const last = parts[parts.length - 1];
  const state = /^[A-Za-z]{2}$/.test(last) ? last.toUpperCase() : null;

  const city = state ? parts.slice(0, -1).join(" ") : cleaned;
  return { city: city.trim() || null, state };
}

async function findLotsByCodeOrSlug(raw) {
  const slugCandidate = raw.toLowerCase().replace(/\s+/g, "-");

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

// ---------- stalls-left helpers ----------

async function getStallsLeftTonight(lotId) {
  try {
    const { data, error } = await supabase.rpc("openyard_stalls_left", {
      p_lot_id: lotId,
    });
    if (error) throw error;
    return typeof data === "number" ? data : null;
  } catch (err) {
    console.error("RPC openyard_stalls_left error:", err);
    return null;
  }
}

async function getMinStallsLeftForStay(lotId, startDate, endDate) {
  try {
    const { data, error } = await supabase.rpc("openyard_stalls_left_range", {
      p_lot_id: lotId,
      p_start_date: startDate,
      p_end_date: endDate,
    });
    if (error) throw error;
    return typeof data === "number" ? data : null;
  } catch (err) {
    console.error("RPC openyard_stalls_left_range error:", err);
    return null;
  }
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function addDaysIso(startIso, days) {
  const dt = new Date(startIso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt);
}

// ----------------------------------------

export async function handleLocationState(conversation, text) {
  const raw = String(text || "").trim();

  await updateConversation(conversation.id, { location_raw_input: raw });

  // 1) Try code/slug match first
  let lots = await findLotsByCodeOrSlug(raw);

  // 2) If none, try city/state
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

    const stallsLeft = await getStallsLeftTonight(lot.id);

    // If we KNOW it's sold out, block early (prevents wasting steps)
    if (typeof stallsLeft === "number" && stallsLeft <= 0) {
      return (
        `Sorry — ${lot.name}${
          lot.region_label ? " – " + lot.region_label : ""
        } is sold out tonight.\n\n` +
        'Try another city/state, or text SUPPORT.'
      );
    }

    await updateConversation(conversation.id, {
      lot_id: lot.id,
      current_state: "awaiting_name",
    });

    const stallsLine =
      typeof stallsLeft === "number" ? `\nSpots left tonight: ${stallsLeft}` : "";

    return (
      `You’re booking: ${lot.name}${
        lot.region_label ? " – " + lot.region_label : ""
      }.${stallsLine}\n\n` + "What’s your first and last name?"
    );
  }

  // MULTIPLE LOTS
  const limited = lots.slice(0, 5);

  const stalls = await Promise.all(
    limited.map(async (lot) => ({
      lotId: lot.id,
      stallsLeft: await getStallsLeftTonight(lot.id),
    }))
  );

  const stallsById = new Map(stalls.map((s) => [s.lotId, s.stallsLeft]));

  const lines = limited.map((lot, i) => {
    const left = stallsById.get(lot.id);
    const leftTxt = typeof left === "number" ? ` • ${left} left` : "";
    return `${i + 1}) ${lot.name}${
      lot.region_label ? " – " + lot.region_label : ""
    }${leftTxt}`;
  });

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

  let lots = [];
  if (city) lots = await findLotsByCityState(city, state);
  if (!lots || lots.length === 0) lots = await findLotsByCodeOrSlug(input);

  const limited = (lots || []).slice(0, 5);
  if (n > limited.length) return "Please choose a valid number.";

  const chosen = limited[n - 1];

  const stallsLeft = await getStallsLeftTonight(chosen.id);

  // If we KNOW it's sold out, block early and keep them in lot-choice state
  if (typeof stallsLeft === "number" && stallsLeft <= 0) {
    await updateConversation(conversation.id, {
      current_state: "awaiting_lot_choice",
    });

    return (
      `That lot is sold out tonight.\n` +
      `Reply with a different number from the list, or text SUPPORT.`
    );
  }

  await updateConversation(conversation.id, {
    lot_id: chosen.id,
    current_state: "awaiting_name",
  });

  const stallsLine =
    typeof stallsLeft === "number" ? `\nSpots left tonight: ${stallsLeft}` : "";

  return (
    `You’re booking: ${chosen.name}${
      chosen.region_label ? " – " + chosen.region_label : ""
    }.${stallsLine}\n\n` + "What’s your first and last name?"
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
  const types = { 1: "semi", 2: "bobtail", 3: "hotshot", 4: "other" };
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

  // Availability: tonight + minimum across stay
  const stallsTonight = await getStallsLeftTonight(lot.id);

  const startDate = isoDate(new Date());
  const endDate = addDaysIso(startDate, Number(nights || 1));
  const stallsMin =
    Number(nights || 1) > 1
      ? await getMinStallsLeftForStay(lot.id, startDate, endDate)
      : stallsTonight;

  const stallsLines = [];
  if (typeof stallsTonight === "number") {
    stallsLines.push(`• Spots left tonight: ${stallsTonight}`);
  }
  if (typeof stallsMin === "number" && Number(nights || 1) > 1) {
    stallsLines.push(`• Min spots during stay: ${stallsMin}`);
  }

  const stallsBlock = stallsLines.length ? `\n${stallsLines.join("\n")}\n` : "\n";

  // total comes from your pricing logic in payments (authoritative)
  // Here we keep the SMS summary simple and let createBooking compute total.
  return withCommandsFooter(
    "Here’s your booking:\n" +
      `• Lot: ${lot.name}${lot.region_label ? " – " + lot.region_label : ""}\n` +
      stallsBlock +
      `• Name: ${conv.driver_full_name}\n` +
      `• Truck: ${conv.truck_type} – ${conv.truck_make_model}\n` +
      `• Plate: ${conv.license_plate_raw}\n` +
      `• Stay: ${nights} night(s)\n\n` +
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

  return null;
}

export async function handleAwaitingPaymentState(conversation, trimmedUpper) {
  const wantsLink = ["LINK", "PAY", "PAYMENT", "YES", "Y", "RESEND"].includes(
    String(trimmedUpper || "").toUpperCase().trim()
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
