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

  // DEMO
  if (upper === 'DEMO') {
    await logSms(null, phone, 'inbound', text, rawPayload);
    return (
      'OpenYard demo – here’s what drivers see:\n\n' +
      '1) Text BOOK\n' +
      '2) Choose a lot\n' +
      '3) Enter truck + plate + nights\n' +
      '4) Pay securely by card\n' +
      '5) Receive parking confirmation + instructions'
    );
  }

  // MENU
  if (upper === 'MENU') {
    await logSms(null, phone, 'inbound', text, rawPayload);
    return (
      'OpenYard commands:\n' +
      'BOOK – start a reservation\n' +
      'RESET – start over\n' +
      'CANCEL – cancel booking\n' +
      'SUPPORT – talk to a human'
    );
  }

  // HELP
  if (upper === 'HELP') {
    await logSms(null, phone, 'inbound', text, rawPayload);
    return 'Text BOOK to start a reservation or SUPPORT for help.';
  }

  // CANCEL / STOP
  if (upper === 'CANCEL' || upper === 'STOP') {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, 'inbound', text, rawPayload);
    return 'Your booking flow has been cancelled. You will not be charged.';
  }

  // RESET
  if (upper === 'RESET') {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, 'inbound', text, rawPayload);
    return 'All set. Text BOOK to start a new reservation.';
  }

  // SUPPORT
  if (upper === 'SUPPORT') {
    await logSms(null, phone, 'inbound', text, rawPayload);
    const ownerPhone = process.env.ALERT_PHONE_E164;

    if (ownerPhone) {
      await notifyOwnerAlert(`Support request from ${phone}: "${text}"`);
      return 'Thanks — a human will follow up shortly.';
    }

    return 'Support not configured yet. Please email alex@openyardpark.com.';
  }

  // Load active conversation
  const { data: convRows } = await supabase
    .from('conversations')
    .select('*')
    .eq('driver_phone_e164', phone)
    .eq('is_active', true)
    .limit(1);

  let conversation = convRows && convRows[0] ? convRows[0] : null;

  // Auto-expire after 30 min
  if (conversation?.last_inbound_at) {
    const last = new Date(conversation.last_inbound_at).getTime();
    if (Date.now() - last > 30 * 60 * 1000) {
      await deactivateActiveConversations(phone);
      conversation = null;
    }
  }

  // BOOK
  if (upper === 'BOOK') {
    if (conversation) {
      await deactivateActiveConversations(phone);
    }

    const { data: newConv } = await supabase
      .from('conversations')
      .insert({
        driver_phone_e164: phone,
        current_state: 'awaiting_location_or_lot_code',
        is_active: true,
        last_inbound_at: new Date().toISOString(),
      })
      .select()
      .single();

    await logSms(newConv.id, phone, 'inbound', text, rawPayload);

    return withCommandsFooter(
      'Where do you want to park?\nReply with a city/state or lot code.\n\nReply STOP to opt out.'
    );
  }

  if (!conversation) {
    await logSms(null, phone, 'inbound', text, rawPayload);
    return 'Text BOOK to start a reservation.';
  }

  await logSms(conversation.id, phone, 'inbound', text, rawPayload);
  await updateConversation(conversation.id, {
    last_inbound_at: new Date().toISOString(),
  });

  switch (conversation.current_state) {
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
      return maybeNull === null ? createBooking(conversation) : maybeNull;
    }
    case 'awaiting_payment':
      return handleAwaitingPaymentState(conversation, text);
    default:
      return 'Text BOOK to start a reservation.';
  }
}
