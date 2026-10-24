/**
 * Baileys auth state stored in Supabase instead of the local disk.
 *
 * Render's free instances have an ephemeral disk, so a session saved with
 * useMultiFileAuthState disappears on every restart or redeploy and the
 * customer has to link WhatsApp again. Keeping the same records in the
 * `whatsapp_node_sessions` table (one row per key, scoped by node_id) makes
 * the session survive restarts.
 *
 * Same record layout as Baileys' useMultiFileAuthState: `creds` plus one
 * record per signal key (`<type>-<id>`), serialised with BufferJSON.
 */
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { slotPrefix } from './slots.js';

export { slotPrefix };

const TABLE = 'whatsapp_node_sessions';
const READ_CHUNK = 200;

function serialise(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function deserialise(value) {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

export async function useSupabaseAuthState(supabase, nodeId, slot = 0) {
  const prefix = slotPrefix(slot);
  async function readMany(rawKeys) {
    const keys = rawKeys.map((key) => prefix + key);
    const found = new Map();
    for (let index = 0; index < keys.length; index += READ_CHUNK) {
      const slice = keys.slice(index, index + READ_CHUNK);
      const { data, error } = await supabase
        .from(TABLE)
        .select('key,value')
        .eq('node_id', nodeId)
        .in('key', slice);
      if (error) throw new Error(`SESSION_READ_FAILED: ${error.message}`);
      for (const row of data || []) found.set(row.key.slice(prefix.length), deserialise(row.value));
    }
    return found;
  }

  async function writeMany(entries) {
    if (!entries.length) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from(TABLE).upsert(
      entries.map(([key, value]) => ({ node_id: nodeId, key: prefix + key, value: serialise(value), updated_at: now })),
      { onConflict: 'node_id,key' }
    );
    if (error) throw new Error(`SESSION_WRITE_FAILED: ${error.message}`);
  }

  async function removeMany(keys) {
    if (!keys.length) return;
    const { error } = await supabase.from(TABLE).delete().eq('node_id', nodeId).in('key', keys.map((key) => prefix + key));
    if (error) throw new Error(`SESSION_DELETE_FAILED: ${error.message}`);
  }

  const stored = await readMany(['creds']);
  const creds = stored.get('creds') || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const records = await readMany(ids.map((id) => `${type}-${id}`));
          const result = {};
          for (const id of ids) {
            let value = records.get(`${type}-${id}`) ?? null;
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            result[id] = value;
          }
          return result;
        },
        set: async (data) => {
          const writes = [];
          const deletes = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) writes.push([key, value]);
              else deletes.push(key);
            }
          }
          await writeMany(writes);
          await removeMany(deletes);
        },
      },
    },
    saveCreds: () => writeMany([['creds', creds]]),
  };
}

/** Wipes one slot only: other customers on the same node keep their sessions. */
export async function clearSupabaseAuthState(supabase, nodeId, slot = 0) {
  const prefix = slotPrefix(slot);
  const query = supabase.from(TABLE).delete().eq('node_id', nodeId);
  // Slot 0 owns every key without a slot prefix.
  const { error } = prefix ? await query.like('key', `${prefix}%`) : await query.not('key', 'like', 'slot%/%');
  if (error) throw new Error(`SESSION_CLEAR_FAILED: ${error.message}`);
}
