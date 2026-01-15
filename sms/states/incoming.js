// lib/sms/incoming.ts
import { createClient } from "@supabase/supabase-js";

// NOTE: This file is a port of your sms/handler.js logic,
// minus Twilio XML response formatting.
// It returns a plain string reply.

type SupabaseClient = ReturnType<typeof createClient>;

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL as string;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- Tiny helpers (replace with your real implementations if you already have them) ----
function isRateLimited(_fromE164: string) {
  // If you already have a robust limiter elsewhere, wire it here.
  // DB guardrails now catch spam holds; this is just a cheap SMS spam throttle.
  return false;
}

async function notifyOwnerAlert(_msg: string) {
  // Optional: wire to Telnyx outbound to your alert phone, Slack, etc.
  // Keep it non-blocking.
}

async function logSms(
  supabase: SupabaseClient,
  conversationId: string | null,
  phone: string,
  direction: "inbound" | "outbound",
  text: string,
  rawPayload?: any
) {
  // If you already have logSms in your SMS repo, feel free to replace this.
  await supabase.from("sms_logs").insert({
    conversation_id: conversationId,
    phone_e164: phone,
    direction,
    body: text,
    raw_payload: rawPayload ?? null,
  });
}

async function updateConversation(
  supabase: SupabaseClient,
  conversationId: string,
  patch: Record<string, any>
) {
  await supabase.from("conversations").update(patch).eq("id", conversationId);
}

async function deactivateActiveConversations(supabase: SupabaseClient, phone: string) {
  await supabase
    .from("conversations")
    .update({ is_active: false, current_state: "cancelled" })
    .eq("driver_phone_e164", phone)
    .eq("is_active", true);
}

// ---- Import your existing state handlers (you will paste/port them in next step) ----
// For now, we expect you to bring the functions over or create wrappers.
// These should return string responses.
export type StateHandlers = {
  withCommandsFooter: (mainText: string) => string;
  handleLocationState: (conversation: any, text: string) => Promise<string>;
  handleLotChoiceState: (conversation: any, text: string) => Promise<string>;
  handleNameState: (conversation: any, text: string) => Promise<string>;
  handleTruckTypeState: (conversation: any, text: string) => Promise<string>;
  handleMakeModelState: (conversation: any, text: string) => Promise<string>;
  handlePlateState: (conversation: any, text: string) => Promise<string>;
  handleStayOptionState: (conversation: any, text: string) => Promise<string>;
  handleCustomNightsState: (conversation: any, text: string) => Promise<string>;
  handleSummaryConfirmState: (conversation: any, text: string) => Promise<string | null>;
  handleAwaitingPaymentState: (conversation: any, trimmedUpper: string) => Promise<string>;
  createBooking: (conversation: any) => Promise<string>;
};

export async function handleIncomingSmsShared(args: {
  fromE164: string;
  text: string;
  rawPayload?: any;
  handlers: StateHandlers;
}): Promise<string> {
  const { fromE164, text, rawPayload, handlers } = args;
  const supabase = getSupabaseAdmin();
  const upper = String(text || "").toUpperCase().trim();

  // Default reply
  let replyText =
    "Oops, something went wrong. Please try again in a moment or text SUPPORT for help.";

  try {
    if (!fromE164) {
      return "Invalid sender. Please try again.";
    }
    if (isRateLimited(fromE164)) {
      return "You’re sending messages too quickly. Please wait a moment and try again.";
    }

    // DEMO
    if (upper === "DEMO") {
      await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
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
      await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
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
      await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
      return "Text BOOK to start a reservation or SUPPORT for help.";
    }

    // CANCEL / STOP
    if (upper === "CANCEL" || upper === "STOP") {
      await deactivateActiveConversations(supabase, fromE164);
      await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
      return "Your booking flow has been cancelled. You will not be charged.";
    }

    // RESET
    if (upper === "RESET") {
      await deactivateActiveConversations(supabase, fromE164);
      await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
      return "All set. Text BOOK to start a new reservation.";
    }

    // SUPPORT
    if (upper === "SUPPORT") {
      await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
      await notifyOwnerAlert(`Support request from ${fromE164}: "${text}"`);
      return "Thanks — a human will follow up shortly.";
    }

    // Load active conversation
    const { data: convRows, error: convErr } = await supabase
      .from("conversations")
      .select("*")
      .eq("driver_phone_e164", fromE164)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);

    if (convErr) {
      await notifyOwnerAlert(`Error loading active conversation for ${fromE164}: ${convErr.message}`);
    }

    let conversation = convRows && convRows[0] ? convRows[0] : null;

    // Auto-expire after 30 min (failsafe)
    if (conversation?.last_inbound_at) {
      const last = new Date(conversation.last_inbound_at).getTime();
      if (Date.now() - last > 30 * 60 * 1000) {
        await deactivateActiveConversations(supabase, fromE164);
        conversation = null;
      }
    }

    // BOOK
    if (upper === "BOOK") {
      if (conversation) await deactivateActiveConversations(supabase, fromE164);

      const nowIso = new Date().toISOString();
      const { data: newConv, error: newConvErr } = await supabase
        .from("conversations")
        .insert({
          driver_phone_e164: fromE164,
          current_state: "awaiting_location_or_lot_code",
          is_active: true,
          last_inbound_at: nowIso,
        })
        .select()
        .single();

      if (newConvErr || !newConv) {
        await notifyOwnerAlert(
          `Error creating new conversation for ${fromE164}: ${
            newConvErr ? newConvErr.message : "no row returned"
          }`
        );
        await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
        return "We couldn’t start a booking right now. Please try again.";
      }

      await logSms(supabase, newConv.id, fromE164, "inbound", text, rawPayload);

      return handlers.withCommandsFooter(
        "Where do you want to park?\n" +
          "Reply with a city/state or lot code.\n\n" +
          "Reply STOP to opt out."
      );
    }

    // No active conversation
    if (!conversation) {
      await logSms(supabase, null, fromE164, "inbound", text, rawPayload);
      return "Text BOOK to start a reservation.";
    }

    // Log inbound + bump last_inbound_at
    await logSms(supabase, conversation.id, fromE164, "inbound", text, rawPayload);
    await updateConversation(supabase, conversation.id, {
      last_inbound_at: new Date().toISOString(),
    });

    const refreshConversation = async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select("*")
        .eq("id", conversation.id)
        .single();
      return error ? conversation : data || conversation;
    };

    switch (conversation.current_state) {
      case "awaiting_location_or_lot_code":
        return handlers.handleLocationState(conversation, text);

      case "awaiting_lot_choice":
        return handlers.handleLotChoiceState(conversation, text);

      case "awaiting_name":
        return handlers.handleNameState(conversation, text);

      case "awaiting_truck_type":
        return handlers.handleTruckTypeState(conversation, text);

      case "awaiting_make_model":
        return handlers.handleMakeModelState(conversation, text);

      case "awaiting_plate":
        return handlers.handlePlateState(conversation, text);

      case "awaiting_stay_option":
        return handlers.handleStayOptionState(conversation, text);

      case "awaiting_custom_nights":
        return handlers.handleCustomNightsState(conversation, text);

      case "awaiting_summary_confirmation": {
        const maybeNull = await handlers.handleSummaryConfirmState(conversation, text);
        if (maybeNull !== null) return maybeNull;

        const fresh = await refreshConversation();
        return handlers.createBooking(fresh);
      }

      case "awaiting_payment": {
        const trimmedUpper = String(text || "").trim().toUpperCase();
        return handlers.handleAwaitingPaymentState(conversation, trimmedUpper);
      }

      default:
        return "Text BOOK to start a reservation.";
    }
  } catch (err: any) {
    await notifyOwnerAlert(`Error in handleIncomingSmsShared: ${err?.message || String(err)}`);
    return replyText;
  }
}
