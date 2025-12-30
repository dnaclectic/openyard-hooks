// sms/handler.js
import twilio from "twilio";
import {
  supabase,
  logSms,
  updateConversation,
  deactivateActiveConversations,
} from "../db/db.js";
import { isRateLimited, notifyOwnerAlert } from "../utils/index.js";
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
} from "./states/index.js";
import { createBooking } from "../payments/index.js";

export async function twilioWebhookHandler(req, res) {
  const from = (req.body.From || "").trim();
  const body = (req.body.Body || "").trim();

  console.log("Twilio webhook hit at", new Date().toISOString(), {
    from,
    body,
  });

  // Always respond something (Twilio expects XML quickly)
  let replyText =
    "Oops, something went wrong. Please try again in a moment or text SUPPORT for help.";

  try {
    if (!from) {
      replyText = "Invalid sender. Please try again.";
    } else if (isRateLimited(from)) {
      replyText =
        "You’re sending messages too quickly. Please wait a moment and try again.";
    } else {
      replyText = await handleIncomingSms(from, body, req.body);
    }
  } catch (err) {
    console.error("handleIncomingSms error:", err);
    await notifyOwnerAlert(
      `Error in handleIncomingSms: ${err?.message || String(err)}`
    );
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(replyText);
  return res.type("text/xml").send(twiml.toString());
}

async function handleIncomingSms(phone, text, rawPayload) {
  const upper = String(text || "").toUpperCase().trim();

  // DEMO
  if (upper === "DEMO") {
    await logSms(null, phone, "inbound", text, rawPayload);
    return (
      "OpenYard demo – here’s what drivers see:\n\n" +
      "1) Text BOOK\n" +
      "2) Choose a lot\n" +
      "3) Enter truck + plate + nights\n" +
      "4) Pay securely by card\n" +
      "5) Receive parking confirmation + instructions"
    );
  }

  // MENU
  if (upper === "MENU") {
    await logSms(null, phone, "inbound", text, rawPayload);
    return (
      "OpenYard commands:\n" +
      "BOOK – start a reservation\n" +
      "RESET – start over\n" +
      "CANCEL – cancel booking\n" +
      "SUPPORT – talk to a human"
    );
  }

  // HELP
  if (upper === "HELP") {
    await logSms(null, phone, "inbound", text, rawPayload);
    return "Text BOOK to start a reservation or SUPPORT for help.";
  }

  // CANCEL / STOP
  if (upper === "CANCEL" || upper === "STOP") {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, "inbound", text, rawPayload);
    return "Your booking flow has been cancelled. You will not be charged.";
  }

  // RESET
  if (upper === "RESET") {
    await deactivateActiveConversations(phone);
    await logSms(null, phone, "inbound", text, rawPayload);
    return "All set. Text BOOK to start a new reservation.";
  }

  // SUPPORT
  if (upper === "SUPPORT") {
    await logSms(null, phone, "inbound", text, rawPayload);
    const ownerPhone = process.env.ALERT_PHONE_E164;

    if (ownerPhone) {
      await notifyOwnerAlert(`Support request from ${phone}: "${text}"`);
      return "Thanks — a human will follow up shortly.";
    }

    return "Support not configured yet. Please email alex@openyardpark.com.";
  }

  // Load active conversation
  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("*")
    .eq("driver_phone_e164", phone)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (convErr) {
    console.error("Error loading active conversation:", convErr);
    await notifyOwnerAlert(
      `Error loading active conversation for ${phone}: ${convErr.message}`
    );
  }

  let conversation = convRows && convRows[0] ? convRows[0] : null;

  // Auto-expire after 30 min (failsafe)
  if (conversation?.last_inbound_at) {
    const last = new Date(conversation.last_inbound_at).getTime();
    if (Date.now() - last > 30 * 60 * 1000) {
      await deactivateActiveConversations(phone);
      conversation = null;
    }
  }

  // BOOK
  if (upper === "BOOK") {
    if (conversation) {
      await deactivateActiveConversations(phone);
    }

    const nowIso = new Date().toISOString();
    const { data: newConv, error: newConvErr } = await supabase
      .from("conversations")
      .insert({
        driver_phone_e164: phone,
        current_state: "awaiting_location_or_lot_code",
        is_active: true,
        last_inbound_at: nowIso,
      })
      .select()
      .single();

    if (newConvErr || !newConv) {
      console.error("Error creating new conversation:", newConvErr);
      await notifyOwnerAlert(
        `Error creating new conversation for ${phone}: ${
          newConvErr ? newConvErr.message : "no row returned"
        }`
      );
      await logSms(null, phone, "inbound", text, rawPayload);
      return "We couldn’t start a booking right now. Please try again.";
    }

    await logSms(newConv.id, phone, "inbound", text, rawPayload);

    // Note: "STOP to opt out" is still in the message body (Twilio also supports STOP keywords)
    return withCommandsFooter(
      "Where do you want to park?\n" +
        "Reply with a city/state or lot code.\n\n" +
        "Reply STOP to opt out."
    );
  }

  // No active conversation
  if (!conversation) {
    await logSms(null, phone, "inbound", text, rawPayload);
    return "Text BOOK to start a reservation.";
  }

  // Log inbound + bump last_inbound_at
  await logSms(conversation.id, phone, "inbound", text, rawPayload);
  await updateConversation(conversation.id, {
    last_inbound_at: new Date().toISOString(),
  });

  // IMPORTANT: refresh conversation after state handlers might have changed it
  // (prevents bugs when state updates happen inside handlers)
  const refreshConversation = async () => {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", conversation.id)
      .single();
    if (error) {
      console.error("Error refreshing conversation:", error);
      return conversation;
    }
    return data || conversation;
  };

  switch (conversation.current_state) {
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

    case "awaiting_summary_confirmation": {
      const maybeNull = await handleSummaryConfirmState(conversation, text);
      if (maybeNull !== null) return maybeNull;

      // conversation may not yet include the latest fields needed by createBooking
      const fresh = await refreshConversation();
      return createBooking(fresh);
    }

    case "awaiting_payment": {
      // NOTE: your handleAwaitingPaymentState signature expects (conversation, trimmedUpper)
      const trimmedUpper = String(text || "").trim().toUpperCase();
      return handleAwaitingPaymentState(conversation, trimmedUpper);
    }

    default:
      return "Text BOOK to start a reservation.";
  }
}
