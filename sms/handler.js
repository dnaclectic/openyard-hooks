// sms/handler.js
import twilio from 'twilio';
import {
  supabase,
  logSms,
  updateConversation,
  deactivateActiveConversations,
} from '../db/db.js';
import { isRateLimited, notifyOwnerAlert } from '../utils/index.js';
import {
  withCommandsFooter,
  handleLocationState,
  handleLotChoiceState,
  handleNameState,
  handleTruckTypeState,
  handleMakeModelState,
  handlePlateState,
  handleStayOptionState,
  handleCustomNightsState,
  handleSummaryConfirmState,
  handleAwaitingPaymentState,
} from './states/index.js';
import { createBooking } from '../payments/index.js';

export async function twilioWebhookHandler(req, res) {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  console.log('Twilio webhook hit at', new Date().toISOString(), {
    from,
    body,
  });

  if (isRateLimited(from)) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(
      'You’re sending messages too quickly. Please wait a moment and try again.'
    );
    return res.type('text/xml').send(twiml.toString());
  }

  let replyText =
    'Oops, something went wrong. Please try again in a moment or text SUPPORT for help.';

  try {
    replyText = await handleIncomingSms(from, body, req.body);
  } catch (err) {
    console.error('handleIncomingSms error:', err);
    await notifyOwnerAlert(`Error in handleIncomingSms: ${err.message}`);
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(replyText);

  res.type('text/xml').send(twiml.toString());
}

async function handleIncomingSms(phone, text, rawPayload) {
  const upper = (text || '').toUpperCase().trim();

  // DEMO – owner-facing walkthrough
  if (upper === 'DEMO') {
    await logSms(null, phone, 'inbound', text, rawPayload);

    return (
      'OpenYard demo – here’s what your drivers see:\n\n' +
      '1) They text BOOK to this number.\n' +
      '2) We ask where they want to park (city/exit or lot code).\n' +
      '3) They pick your lot, then enter name, truck, plate, and nights.\n' +
      '4) We text them a secure Stripe payment link to pay by card.\n' +
      '5) After payment, they get a confirmation with parking instructions.\n' +
      '6) The next evening, we send them a quick review link for your lot.\n\n' +
      'If you’d like a live walkthrough, text SUPPORT and we’ll set up a quick demo call.'
    );
  }

  // MENU
  if (upper === 'MENU') {
    await logSms(null, phone, 'inbound', text, rawPayload);

    return (
      'OpenYard commands:\n' +
      'BOOK – start a new reservation\n' +
      'RESET – clear your info and start over\n' +
      'CANCEL – cancel your active booking\n' +
      'SUPPORT – text a human (8a–8p MT)'
    );
  }

  // HELP (fallback if carrier passes it through)
  if (upper === 'HELP') {
    await logSms(null, phone, 'inbound', text, rawPayload);

    return (
      'For help with OpenYard, you can:\n' +
      'BOOK – start a new reservation\n' +
      'RESET – clear and start over\n' +
      'SUPPORT – text a human (8a–8p MT)'
    );
  }

  // CANCEL / STOP
  if (upper === 'CANCEL' || upper === 'STOP') {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, 'inbound', text, rawPayload);

    return 'Okay, your booking flow has been cancelled. You will not be charged for any incomplete bookings.';
  }

  // RESET
  if (upper === 'RESET') {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, 'inbound', text, rawPayload);

    return 'Got it. I’ve cleared your previous booking info. Text BOOK to start a fresh reservation.';
  }

  // SUPPORT
  if (upper === 'SUPPORT') {
    await logSms(null, phone, 'inbound', text, rawPayload);

    const ownerPhone = process.env.ALERT_PHONE_E164;

    if (ownerPhone) {
      try {
        await notifyOwnerAlert(`Support text from ${phone}: "${text}"`);
      } catch (err) {
        console.error('Error sending support alert:', err);
      }

      return 'Thanks for reaching out. A human will review your message and follow up if needed.';
    }

    return (
      'Support is not fully configured yet.\n' +
      'Please email alex@openyardpark.com, or text BOOK to start a new reservation.'
    );
  }

  // Load active conversation
  const { data: convRows, error: convErr } = await supabase
    .from('conversations')
    .select('*')
    .eq('driver_phone_e164', phone)
    .eq('is_active', true)
    .limit(1);

  if (convErr) {
    console.error('Error loading conversation:', convErr);
  }

  let conversation = convRows && convRows[0] ? convRows[0] : null;

  // BOOK – always allowed
  if (upper === 'BOOK') {
    if (conversation) {
      await deactivateActiveConversations(phone);
      conversation = null;
    }

    const nowIso = new Date().toISOString();

    const { data: newConv, error: newConvErr } = await supabase
      .from('conversations')
      .insert({
        driver_phone_e164: phone,
        current_state: 'awaiting_location_or_lot_code',
        is_active: true,
        last_inbound_at: nowIso,
      })
      .select()
      .single();

    if (newConvErr) {
      console.error('Error creating conversation:', newConvErr);
      await notifyOwnerAlert(`Error creating conversation: ${newConvErr.message}`);
      return 'Something went wrong starting your booking. Please try again in a minute.';
    }

    conversation = newConv;

    await logSms(conversation.id, phone, 'inbound', text, rawPayload);

    // FIRST MESSAGE → include commands footer + STOP compliance line
    return withCommandsFooter(
      'Where do you want to park?\n' +
        'Reply with a city and state (e.g. "Bozeman MT").\n\n' +
        'Msg & data rates may apply. Reply STOP to opt out.'
    );
  }

  // No active conversation and not BOOK
  if (!conversation) {
    await logSms(null, phone, 'inbound', text, rawPayload);
    return 'Text BOOK to start a new truck parking reservation.';
  }

  // We have an active conversation
  await logSms(conversation.id, phone, 'inbound', text, rawPayload);
  await updateConversation(conversation.id, {
    last_inbound_at: new Date().toISOString(),
  });

  const state = conversation.current_state;
  const trimmedUpper = (text || '').trim().toUpperCase();

  switch (state) {
    case 'awaiting_location_or_lot_code':
      return handleLocationState(conversation, text);

    case 'awaiting_lot_choice':
      return handleLotChoiceState(conversation, text);

    case 'awaiting_name':
      return handleNameState(conversation, text);

    case 'awaiting_truck_type':
      return handleTruckTypeState(conversation, text);

    case 'awaiting_make_model':
      return handleMakeModelState(conversation, text);

    case 'awaiting_plate':
      return handlePlateState(conversation, text);

    case 'awaiting_stay_option':
      return handleStayOptionState(conversation, text);

    case 'awaiting_custom_nights':
      return handleCustomNightsState(conversation, text);

    case 'awaiting_summary_confirmation': {
      const maybeNull = await handleSummaryConfirmState(conversation, text);
      if (maybeNull === null) {
        // They said YES, so we proceed to create booking
        return createBooking(conversation);
      }
      return maybeNull;
    }

    case 'awaiting_payment':
      return handleAwaitingPaymentState(conversation, trimmedUpper);

    default:
      return 'Text BOOK to start a new booking.';
  }
}
