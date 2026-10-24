// Database access for the AI receptionist (service role only; see migration 202610220003).
import { RECEPTIONIST_LIMITS, settingsFromRow, settingsToRow } from './receptionist.js';

export async function loadReceptionistSettings(service, userId) {
  const { data, error } = await service.from('ai_receptionist_settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return settingsFromRow(data);
}

export async function saveReceptionistSettings(service, userId, settings) {
  const { error } = await service.from('ai_receptionist_settings').upsert(
    { user_id: userId, ...settingsToRow(settings), updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
}

export async function setWhatsAppReceptionist(service, userId, enabled, number) {
  const { error } = await service.from('ai_receptionist_settings').upsert(
    { user_id: userId, whatsapp_enabled: enabled, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );
  if (error) throw error;
  await service.from('ai_receptionist_numbers').delete().eq('user_id', userId).eq('channel', 'whatsapp');
  if (enabled && number) {
    const { error: insertError } = await service.from('ai_receptionist_numbers').insert({ number, user_id: userId, channel: 'whatsapp' });
    if (insertError) throw insertError;
  }
}

export async function listReceptionistNumbers(service, userId) {
  const { data, error } = await service.from('ai_receptionist_numbers').select('number, channel').eq('user_id', userId);
  if (error) throw error;
  return data || [];
}

/** Admin: the provider numbers of one customer (phone channel), replacing the old list. */
export async function replacePhoneNumbers(service, userId, numbers) {
  const { data: taken, error: lookupError } = await service.from('ai_receptionist_numbers')
    .select('number, user_id').in('number', numbers.length ? numbers : ['-']);
  if (lookupError) throw lookupError;
  const conflict = (taken || []).find((row) => row.user_id !== userId);
  if (conflict) return { ok: false, conflict: conflict.number };
  const { error: deleteError } = await service.from('ai_receptionist_numbers').delete().eq('user_id', userId).eq('channel', 'phone');
  if (deleteError) throw deleteError;
  if (numbers.length) {
    const { error } = await service.from('ai_receptionist_numbers').insert(numbers.map((number) => ({ number, user_id: userId, channel: 'phone' })));
    if (error) throw error;
  }
  return { ok: true };
}

/** The customer a called number belongs to: { userId, channel, number } or null. */
export async function findReceptionistOwner(service, candidates) {
  if (!candidates.length) return null;
  const { data, error } = await service.from('ai_receptionist_numbers').select('number, user_id, channel').in('number', candidates);
  if (error) throw error;
  for (const candidate of candidates) {
    const row = (data || []).find((item) => item.number === candidate);
    if (row) return { userId: row.user_id, channel: row.channel, number: row.number };
  }
  return null;
}

export async function listCallLogs(service, userId) {
  const { data, error } = await service.from('ai_call_logs')
    .select('id, channel, caller_number, caller_name, summary, message, callback_number, urgent, transferred, started_at, ended_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(RECEPTIONIST_LIMITS.callLogs);
  if (error) throw error;
  return data || [];
}

export async function saveCallLog(service, row) {
  const { error } = await service.from('ai_call_logs').upsert(row, { onConflict: 'call_id' });
  if (error) throw error;
}
