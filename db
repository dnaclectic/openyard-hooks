
// db/db.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function logSms(conversationId, phone, direction, msg, raw) {
  await supabase.from('sms_messages').insert({
    conversation_id: conversationId,
    driver_phone_e164: phone,
    direction,
    message_body: msg,
    raw_provider_payload: raw ? JSON.stringify(raw).substring(0, 8000) : null,
  });
}

export async function updateConversation(id, fields) {
  await supabase
    .from('conversations')
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

export async function deactivateActiveConversations(phone) {
  await supabase
    .from('conversations')
    .update({
      is_active: false,
      current_state: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('driver_phone_e164', phone)
    .eq('is_active', true);
}
