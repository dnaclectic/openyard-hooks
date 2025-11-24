// server.js – OpenYard SMS Booking Backend (ESM) with next-day 8pm review nudges

import 'dotenv/config';
import express from 'express';
import twilio from 'twilio';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { DateTime } from 'luxon';

const app = express();
const port = process.env.PORT || 3000;

// -----------------------------------------------------
// Clients
// -----------------------------------------------------

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
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
// Stripe webhook (must come BEFORE body parsers)
// -----------------------------------------------------
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

// For everything else, use parsers
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio inbound SMS
app.post('/webhooks/twilio', twilioWebhookHandler);

// Healthcheck (also runs due scheduled messages)
app.get('/healthz', async (req, res) => {
  try {
    await runDueReviewMessages();
    return res.json({ ok: true });
  } catch (err) {
    console.error('healthz error:', err);
    return res.status(500).json({ ok: false });
  }
});

// -----------------------------------------------------
// Twilio → SMS Handler
// -----------------------------------------------------

async function twilioWebhookHandler(req, res) {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  console.log('Twilio webhook hit at', new Date().toISOString(), {
    from,
    body,
  });

  let replyText = 'Sorry, something broke on our end.';

  try {
    replyText = await handleIncomingSms(from, body, req.body);
  } catch (err) {
    console.error('handleIncomingSms error:', err);
    replyText =
      'Oops, something went wrong. Try again or text HELP for assistance.';
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(replyText);

  res.type('text/xml').send(twiml.toString());
}

// -----------------------------------------------------
// Core SMS Machine
// -----------------------------------------------------

async function handleIncomingSms(phone, text, rawPayload) {
  const upper = (text || "").toUpperCase().trim();

  //
  // ──────────────────────────────
  //  GLOBAL COMMANDS (no state needed)
  // ──────────────────────────────
  //

  // HELP – show menu of hotkeys
  if (upper === "HELP") {
    await logSms(null, phone, "inbound", text, rawPayload);

    return (
      "OpenYard Truck Parking help:\n" +
      "\n" +
      "BOOK   – start a new reservation\n" +
      "CANCEL – cancel your active booking\n" +
      "RESET  – clear and start over\n" +
      "HELP   – show this menu\n" +
      "SUPPORT – text a human (8a–8p MT)\n" +
      "\n" +
      "Reply BOOK to begin a new reservation."
    );
  }

  // CANCEL / STOP – kill active conversations
  if (upper === "CANCEL" || upper === "STOP") {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, "inbound", text, rawPayload);

    return "Okay, your booking flow has been cancelled. Text BOOK anytime to start over.";
  }

  // RESET – same as CANCEL, but phrased as “start over”
  if (upper === "RESET") {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, "inbound", text, rawPayload);

    return "Got it. I’ve cleared your previous booking info. Text BOOK to start a fresh reservation.";
  }

  // SUPPORT – forward to you, confirm to driver
  if (upper === "SUPPORT") {
    await logSms(null, phone, "inbound", text, rawPayload);

    const ownerPhone = process.env.ALERT_PHONE_E164;

    if (ownerPhone) {
      // Fire-and-forget: don’t block user response on this
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: ownerPhone,
          body: `OpenYard SUPPORT from ${phone}: "${text}"`,
        });
      } catch (err) {
        console.error("Error sending support alert:", err);
      }

      return (
        "Thanks for reaching out. A human will review your message and follow up if needed.\n" +
        "You can also text BOOK to start or restart a reservation."
      );
    }

    // Fallback if you forget to set ALERT_PHONE_E164
    return (
      "Support is not fully configured yet.\n" +
      "Please email support@openyardpark.com or text BOOK to start a new reservation."
    );
  }

  //
  // ──────────────────────────────
  //  FETCH ACTIVE CONVERSATION
  // ──────────────────────────────
  //

  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .eq("driver_phone_e164", phone)
    .eq("is_active", true)
    .limit(1);

  if (convErr) {
    console.error("Error loading conversation:", convErr);
  }

  let conversation = convRows && convRows[0] ? convRows[0] : null;

  //
  // ──────────────────────────────
  //  BOOK – always allowed, even if a convo exists
  // ──────────────────────────────
  //

  if (upper === "BOOK") {
    // If there’s an active conversation, mark it inactive so this is truly “fresh”
    if (conversation) {
      await deactivateActiveConversations(phone);
      conversation = null;
    }

    // Create a brand new conversation
    const { data: newConv, error: newConvErr } = await supabase
      .from("conversations")
      .insert({
        driver_phone_e164: phone,
        current_state: "awaiting_location_or_lot_code",
        is_active: true,
        last_inbound_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (newConvErr) {
      console.error("Error creating conversation:", newConvErr);
      return "Something went wrong starting your booking. Please try again in a minute.";
    }

    conversation = newConv;

    await logSms(conversation.id, phone, "inbound", text, rawPayload);

    return (
      "Where do you want to park?\n" +
      'Reply with a city/exit (e.g. "Bozeman MT") or a lot code.'
    );
  }

  //
  // ──────────────────────────────
  //  NO ACTIVE CONVERSATION & NO BOOK
  // ──────────────────────────────
  //

  if (!conversation) {
    await logSms(null, phone, "inbound", text, rawPayload);
    return "Text BOOK to start a new truck parking reservation.";
  }

  //
  // We *do* have an active conversation – log the SMS and route by state
  //
  await logSms(conversation.id, phone, "inbound", text, rawPayload);

  const state = conversation.current_state;

  switch (state) {
    case "awaiting_location_or_lot_code":
      return handleLocationState(conversation, text);

    case "awaiting_lot_choice":
      return handleLotChoiceState(conversation, text);

    case "awaiting_name":
      return handleNameState(conversation, text);

    case "awaiting_truck_type":
      return handleTruckTypeState(conversation, text);

    case "awaiting_make_model":
      return handleMakeModelState(conversation, text);

    case "awaiting_plate":
      return handlePlateState(conversation, text);

    case "awaiting_stay_option":
      return handleStayOptionState(conversation, text);

    case "awaiting_custom_nights":
      return handleCustomNightsState(conversation, text);

    case "awaiting_summary_confirmation":
      return handleSummaryConfirmState(conversation, text);

    case "awaiting_payment":
      return (
        "Your payment link was already sent.\n" +
        "Complete payment to confirm, or text RESET to start over."
      );

    default:
      return "Text BOOK to start a new booking.";
  }
}
// -----------------------------------------------------
// Per-State Handlers
// -----------------------------------------------------

async function handleLocationState(conversation, text) {
  const raw = text.trim();

  await updateConversation(conversation.id, { location_raw_input: raw });

  // Try slug/lot_code exact match
  let { data: lots, error: lotsErr } = await supabase
    .from('lots')
    .select('*')
    .eq('is_active', true)
    .or(
      `lot_code.ilike.${raw},slug.ilike.${raw.toLowerCase().replace(/\s+/g, '-')}`
    );

  if (lotsErr) {
    console.error('Error fetching lots (slug/code):', lotsErr);
  }

  // If none, try city/state
  if (!lots || lots.length === 0) {
    const parts = raw.split(/\s+/);
    const city = parts[0];
    const state = parts[1] || null;

    let q = supabase
      .from('lots')
      .select('*')
      .eq('is_active', true)
      .ilike('city', `${city}%`);

    if (state) q = q.ilike('state', `${state}%`);

    const { data: results, error: cityErr } = await q;
    if (cityErr) {
      console.error('Error fetching lots (city/state):', cityErr);
    }
    lots = results || [];
  }

  if (!lots || lots.length === 0) {
    return (
      "I couldn't find any lots near that.\n" +
      'Try a city + state (e.g. "Bozeman MT").'
    );
  }

  // SINGLE LOT
  if (lots.length === 1) {
    const lot = lots[0];

    await updateConversation(conversation.id, {
      lot_id: lot.id,
      current_state: 'awaiting_name',
    });

    return (
      `You’re booking: ${lot.name}${
        lot.region_label ? ' – ' + lot.region_label : ''
      }.\n` + 'What’s your first and last name?'
    );
  }

  // MULTIPLE LOTS
  const limited = lots.slice(0, 5);
  const lines = limited.map(
    (lot, i) =>
      `${i + 1}) ${lot.name}${lot.region_label ? ' – ' + lot.region_label : ''}`
  );

  await updateConversation(conversation.id, {
    current_state: 'awaiting_lot_choice',
  });

  return 'I found these lots:\n' + lines.join('\n') + '\n\nReply with a number.';
}

async function handleLotChoiceState(conversation, text) {
  const n = parseInt(text.trim(), 10);
  if (Number.isNaN(n) || n < 1) {
    return 'Reply with a valid number from the list.';
  }

  const input = conversation.location_raw_input || '';
  const parts = input.split(/\s+/);
  const city = parts[0];
  const state = parts[1] || null;

  let q = supabase
    .from('lots')
    .select('*')
    .eq('is_active', true)
    .ilike('city', `${city}%`);

  if (state) q = q.ilike('state', `${state}%`);

  const { data: lots, error: lotsErr } = await q;
  if (lotsErr) {
    console.error('Error refetching lots for lot choice:', lotsErr);
  }

  const limited = (lots || []).slice(0, 5);
  if (n > limited.length) return 'Please choose a valid number.';

  const chosen = limited[n - 1];

  await updateConversation(conversation.id, {
    lot_id: chosen.id,
    current_state: 'awaiting_name',
  });

  return (
    `You’re booking: ${chosen.name}${
      chosen.region_label ? ' – ' + chosen.region_label : ''
    }.\n` + 'What’s your first and last name?'
  );
}

async function handleNameState(conversation, text) {
  const full = text.trim();
  if (!full || full.length < 2) return 'Please send your full name.';

  await updateConversation(conversation.id, {
    driver_full_name: full,
    current_state: 'awaiting_truck_type',
  });

  return (
    'What are you parking?\n' +
    '1 = Semi\n' +
    '2 = Bobtail\n' +
    '3 = Hotshot\n' +
    '4 = Other\n' +
    'Reply with a number.'
  );
}

async function handleTruckTypeState(conversation, text) {
  const n = parseInt(text.trim(), 10);
  const types = {
    1: 'semi',
    2: 'bobtail',
    3: 'hotshot',
    4: 'other',
  };
  const truckType = types[n];
  if (!truckType) return 'Reply 1, 2, 3, or 4.';

  await updateConversation(conversation.id, {
    truck_type: truckType,
    current_state: 'awaiting_make_model',
  });

  return 'Truck make & model? (e.g. "Freightliner Cascadia")';
}

async function handleMakeModelState(conversation, text) {
  const v = text.trim();
  if (!v || v.length < 2) return 'Please send truck make & model.';

  await updateConversation(conversation.id, {
    truck_make_model: v,
    current_state: 'awaiting_plate',
  });

  return 'Plate (state + number)? (e.g. "MT 7-XYZ456")';
}

async function handlePlateState(conversation, text) {
  const v = text.trim();
  if (!v || v.length < 2) return 'Please send a valid license plate.';

  await updateConversation(conversation.id, {
    license_plate_raw: v,
    current_state: 'awaiting_stay_option',
  });

  return (
    'How long are you staying?\n' +
    '1 = 1 night\n' +
    '2 = 7 nights\n' +
    '3 = 30 nights\n' +
    '4 = Other\n' +
    'Reply with a number.'
  );
}

async function handleStayOptionState(conversation, text) {
  const n = parseInt(text.trim(), 10);
  if (![1, 2, 3, 4].includes(n)) return 'Reply 1–4.';

  let stayType;
  let nights;

  if (n === 1) {
    stayType = 'overnight';
    nights = 1;
  } else if (n === 2) {
    stayType = 'weekly';
    nights = 7;
  } else if (n === 3) {
    stayType = 'monthly';
    nights = 30;
  } else {
    await updateConversation(conversation.id, {
      current_state: 'awaiting_custom_nights',
    });
    return 'How many nights?';
  }

  await updateConversation(conversation.id, {
    stay_type: stayType,
    nights,
    current_state: 'awaiting_summary_confirmation',
  });

  return buildSummaryPrompt(conversation.id, stayType, nights);
}

async function handleCustomNightsState(conversation, text) {
  const n = parseInt(text.trim(), 10);
  if (Number.isNaN(n) || n < 1 || n > 90) return 'Enter 1–90 nights.';

  await updateConversation(conversation.id, {
    stay_type: 'custom',
    nights: n,
    current_state: 'awaiting_summary_confirmation',
  });

  return buildSummaryPrompt(conversation.id, 'custom', n);
}

async function buildSummaryPrompt(conversationId, stayType, nights) {
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .single();

  if (convErr) {
    console.error('Error loading conversation for summary:', convErr);
    return "We couldn't build your summary. Try again in a moment.";
  }

  const { data: lot, error: lotErr } = await supabase
    .from('lots')
    .select('*')
    .eq('id', conv.lot_id)
    .single();

  if (lotErr) {
    console.error('Error loading lot for summary:', lotErr);
    return "We couldn't load the lot details. Try again shortly.";
  }

  const pricing = computePricing(lot, stayType, nights);
  const totalDollars = (pricing.total_cents / 100).toFixed(2);

  await updateConversation(conversationId, {
    quoted_total_cents: pricing.total_cents,
  });

  return (
    'Here’s your booking:\n' +
    `• Lot: ${lot.name}${lot.region_label ? ' – ' + lot.region_label : ''}\n` +
    `• Name: ${conv.driver_full_name}\n` +
    `• Truck: ${conv.truck_type} – ${conv.truck_make_model}\n` +
    `• Plate: ${conv.license_plate_raw}\n` +
    `• Stay: ${nights} night(s)\n` +
    `• Total: $${totalDollars}\n\n` +
    'Reply YES to get your payment link, or NO to cancel.'
  );
}

async function handleSummaryConfirmState(conversation, text) {
  const upper = text.trim().toUpperCase();

  if (upper === 'NO' || upper === 'N') {
    await updateConversation(conversation.id, {
      current_state: 'cancelled',
      is_active: false,
    });
    return 'No problem, booking cancelled.';
  }

  if (!(upper === 'YES' || upper === 'Y')) {
    return 'Reply YES to get your payment link, or NO to cancel.';
  }

  return createBooking(conversation);
}

// -----------------------------------------------------
// CREATE BOOKING + STRIPE CHECKOUT
// -----------------------------------------------------

async function createBooking(conversation) {
  const { data: conv, error: convErr } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversation.id)
    .single();

  if (convErr) {
    console.error('Error reloading conversation for booking:', convErr);
    return "We couldn't create your booking. Please try again.";
  }

  const { data: lot, error: lotErr } = await supabase
    .from('lots')
    .select('*')
    .eq('id', conv.lot_id)
    .single();

  if (lotErr) {
    console.error('Error loading lot for booking:', lotErr);
    return "We couldn't find that lot. Try again.";
  }

  const pricing = computePricing(lot, conv.stay_type, conv.nights);

  const today = new Date();
  const startDate = today.toISOString().slice(0, 10);
  const end = new Date(today);
  end.setDate(end.getDate() + (conv.nights || 1));
  const endDate = end.toISOString().slice(0, 10);

  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
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
      currency: 'usd',
      status: 'pending_payment',
    })
    .select()
    .single();

  if (bookingErr) {
    console.error('Supabase insert booking error:', bookingErr);
    return "We couldn't create your booking. Please try again.";
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
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
      process.env.CHECKOUT_SUCCESS_URL || 'https://openyardpark.com/success',
    cancel_url:
      process.env.CHECKOUT_CANCEL_URL || 'https://openyardpark.com/cancel',
  });

  await supabase
    .from('bookings')
    .update({
      stripe_session_id: session.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', booking.id);

  await updateConversation(conv.id, {
    booking_id: booking.id,
    current_state: 'awaiting_payment',
  });

  await logSms(conv.id, conv.driver_phone_e164, 'outbound', session.url);

  return "Here’s your secure payment link:\n" + session.url;
}

// -----------------------------------------------------
// PRICE CALC
// -----------------------------------------------------

function computePricing(lot, stayType, nights) {
  const n = Number(nights || 1);
  const nightly = lot.nightly_rate_cents || 2500;

  let subtotal = nightly * n;

  if (stayType === 'weekly' && lot.weekly_rate_cents) {
    subtotal = lot.weekly_rate_cents;
  }
  if (stayType === 'monthly' && lot.monthly_rate_cents) {
    subtotal = lot.monthly_rate_cents;
  }

  const depositHold = 0;
  const total = subtotal + depositHold;

  return {
    nightly_rate_cents: nightly,
    weekly_rate_cents: lot.weekly_rate_cents,
    monthly_rate_cents: lot.monthly_rate_cents,
    subtotal_cents: subtotal,
    deposit_hold_cents: depositHold,
    total_cents: total,
  };
}

// -----------------------------------------------------
// STRIPE WEBHOOK  (confirm + schedule review SMS)
// -----------------------------------------------------

async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe signature error:', err.message);
    return res.status(400).send('Invalid signature');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const bookingId = session.metadata && session.metadata.booking_id;

    if (!bookingId) {
      console.warn('Stripe: missing booking_id');
      return res.send('ok');
    }

    const nowIso = new Date().toISOString();

    const { data: rows, error: updErr } = await supabase
      .from('bookings')
      .update({
        status: 'confirmed',
        paid_at: nowIso,
        stripe_payment_intent_id: session.payment_intent,
        stripe_customer_id: session.customer,
      })
      .eq('id', bookingId)
      .select()
      .limit(1);

    if (updErr || !rows || rows.length === 0) {
      console.error('Error updating booking on payment:', updErr);
      return res.send('ok');
    }

    const booking = rows[0];

    // Mark conversation inactive/completed so they can book again
    await supabase
      .from('conversations')
      .update({
        is_active: false,
        current_state: 'completed',
        updated_at: nowIso,
      })
      .eq('id', booking.conversation_id);

    // Load lot for instructions + review_url + time_zone
    const { data: lot, error: lotErr } = await supabase
      .from('lots')
      .select('*')
      .eq('id', booking.lot_id)
      .single();

    if (lotErr) {
      console.error('Error loading lot for confirmation:', lotErr);
    }

    const instructions =
      lot && lot.parking_instructions
        ? lot.parking_instructions
        : 'Park in marked truck stalls.';

    const confirmMsg =
      '✅ Your booking is confirmed!\n' +
      `${lot ? lot.name : 'OpenYard lot'}${
        lot && lot.region_label ? ' – ' + lot.region_label : ''
      }\n` +
      `Dates: ${booking.start_date} to ${booking.end_date}\n` +
      `Plate: ${booking.license_plate_raw}\n\n` +
      `Instructions:\n${instructions}`;

    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: booking.driver_phone_e164,
      body: confirmMsg,
    });

    await logSms(
      booking.conversation_id,
      booking.driver_phone_e164,
      'outbound',
      confirmMsg
    );

    // Schedule review-nudge SMS for next day at 8pm lot local time
    const sendAtIso = computeReviewSendAt(lot);
    const driverName = booking.driver_full_name || null;

    await supabase.from('scheduled_messages').insert({
      booking_id: booking.id,
      lot_id: booking.lot_id,
      driver_phone_e164: booking.driver_phone_e164,
      driver_full_name: driverName,
      message_type: 'review_nudge',
      send_at: sendAtIso,
    });
  }

  res.send('ok');
}

// -----------------------------------------------------
// Scheduling helpers
// -----------------------------------------------------

function computeReviewSendAt(lot) {
  const lotTz = (lot && lot.time_zone) || 'America/Denver';

  // Now in lot's local time
  const nowLot = DateTime.now().setZone(lotTz);

  // Next calendar day at 20:00 local
  const nextDay8pmLot = nowLot
    .plus({ days: 1 })
    .startOf('day')
    .plus({ hours: 20 });

  return nextDay8pmLot.toUTC().toISO();
}

async function runDueReviewMessages() {
  const nowIso = new Date().toISOString();

  const { data: due, error: dueErr } = await supabase
    .from('scheduled_messages')
    .select('*')
    .is('sent_at', null)
    .lte('send_at', nowIso)
    .limit(10);

  if (dueErr) {
    console.error('Error fetching scheduled messages:', dueErr);
    return;
  }

  if (!due || due.length === 0) {
    return;
  }

  for (const msg of due) {
    try {
      const { data: lot, error: lotErr } = await supabase
        .from('lots')
        .select('name, region_label, review_url')
        .eq('id', msg.lot_id)
        .single();

      if (lotErr) {
        console.error('Error loading lot for review nudge:', msg.id, lotErr);
      }

      const reviewUrl = lot && lot.review_url ? lot.review_url : null;

      if (!reviewUrl) {
        await supabase
          .from('scheduled_messages')
          .update({
            sent_at: new Date().toISOString(),
            last_error: 'no review_url on lot',
          })
          .eq('id', msg.id);
        continue;
      }

      // Fetch booking to get conversation_id
      const { data: bookingRows, error: bookingErr } = await supabase
        .from('bookings')
        .select('conversation_id')
        .eq('id', msg.booking_id)
        .limit(1);

      if (bookingErr) {
        console.error('Error loading booking for review nudge:', msg.id, bookingErr);
      }

      const booking = bookingRows && bookingRows[0];

      let firstName = 'driver';
      if (msg.driver_full_name) {
        firstName = msg.driver_full_name.trim().split(/\s+/)[0] || 'driver';
      }

      const body =
        `Hey ${firstName}, thanks for parking with OpenYard last night! ` +
        `Hope it went smooth. If you have a second, the lot owner would really appreciate a review. ` +
        `Safe travels! ${reviewUrl}`;

      await twilioClient.messages.create({
        from: process.env.TWILIO_PHONE_NUMBER,
        to: msg.driver_phone_e164,
        body,
      });

      await supabase
        .from('scheduled_messages')
        .update({
          sent_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('id', msg.id);

      await logSms(
        booking ? booking.conversation_id : null,
        msg.driver_phone_e164,
        'outbound',
        body
      );
    } catch (err) {
      console.error('Error sending scheduled message', msg.id, err);
      await supabase
        .from('scheduled_messages')
        .update({
          last_error: err.message,
        })
        .eq('id', msg.id);
    }
  }
}

// -----------------------------------------------------
// Utilities
// -----------------------------------------------------

function computeReviewSendAt(lot) {
  // TEST MODE: send review SMS in 2 minutes
  return DateTime.utc().plus({ minutes: 2 }).toISO();
}

async function logSms(conversationId, phone, direction, msg, raw) {
  await supabase.from('sms_messages').insert({
    conversation_id: conversationId,
    driver_phone_e164: phone,
    direction,
    message_body: msg,
    raw_provider_payload: raw ? JSON.stringify(raw).substring(0, 8000) : null,
  });
}

async function updateConversation(id, fields) {
  await supabase
    .from('conversations')
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

async function deactivateActiveConversations(phone) {
  await supabase
    .from('conversations')
    .update({
      is_active: false,
      current_state: 'cancelled',
    })
    .eq('driver_phone_e164', phone)
    .eq('is_active', true);
}

// -----------------------------------------------------
// Start server
// -----------------------------------------------------

app.listen(port, () =>
  console.log(`OpenYard backend listening on port ${port}`)
);
