/**
 * Names the WhatsApp session knows (saved contact names, push names, group
 * subjects), so a voice command like "أرسل لأحمد" can be resolved to a chat.
 * Kept with the session (Supabase session table, or local file) and wiped
 * with it on reset. Nothing here leaves the node except search results.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { slotPrefix } from './slots.js';

const STORE_KEY = 'smartz-contacts';

/** Arabic-aware normalisation: no diacritics/tatweel, unified alef/ya/ta marbuta, lower-case Latin. */
export function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ContactBook {
  constructor({ supabase, nodeId, dir, slot = 0 }) {
    this.supabase = supabase;
    this.nodeId = nodeId;
    this.storeKey = slotPrefix(slot) + STORE_KEY;
    this.file = path.join(dir, slot > 0 ? `auth_info_baileys_slot${slot}` : 'auth_info_baileys', 'contacts.json');
    this.people = new Map(); // jid -> { jid, name, notify }
    this.groups = new Map(); // jid -> { jid, name }
    this.saveTimer = null;
  }

  async load() {
    let stored = null;
    if (this.supabase) {
      const { data } = await this.supabase.from('whatsapp_node_sessions')
        .select('value').eq('node_id', this.nodeId).eq('key', this.storeKey).maybeSingle();
      stored = data?.value || null;
    } else {
      stored = JSON.parse(await fs.readFile(this.file, 'utf8').catch(() => 'null'));
    }
    for (const person of stored?.people || []) this.people.set(person.jid, person);
    for (const group of stored?.groups || []) this.groups.set(group.jid, group);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.save().catch(() => {}); }, 5000);
  }

  async save() {
    const value = { people: [...this.people.values()], groups: [...this.groups.values()] };
    if (this.supabase) {
      await this.supabase.from('whatsapp_node_sessions').upsert(
        { node_id: this.nodeId, key: this.storeKey, value, updated_at: new Date().toISOString() },
        { onConflict: 'node_id,key' },
      );
    } else {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(value));
    }
  }

  async clear() {
    clearTimeout(this.saveTimer);
    this.people.clear();
    this.groups.clear();
    if (this.supabase) {
      await this.supabase.from('whatsapp_node_sessions').delete().eq('node_id', this.nodeId).eq('key', this.storeKey);
    }
  }

  upsert(list = []) {
    let changed = false;
    for (const contact of list) {
      const jid = contact?.id;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
      const current = this.people.get(jid) || { jid };
      const next = {
        jid,
        name: contact.name || contact.verifiedName || current.name || '',
        notify: contact.notify || current.notify || '',
      };
      if (next.name !== current.name || next.notify !== current.notify) {
        this.people.set(jid, next);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  setGroups(list = []) {
    this.groups.clear();
    this.addGroups(list);
  }

  addGroups(list = []) {
    for (const group of list) {
      if (group?.id && group.subject) this.groups.set(group.id, { jid: group.id, name: group.subject });
    }
    this.scheduleSave();
  }

  /**
   * Best matches for a spoken name: exact name first, then names that start
   * with it, then names containing every word of it. A phone number matches
   * the chat for that number directly.
   */
  search(query, { groups = false, limit = 5, ownNumber = '' } = {}) {
    let digits = String(query || '').replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0') && ownNumber) {
      // Local format (0501234567): borrow the country code from the linked number (966501234567).
      const national = digits.slice(1);
      const code = ownNumber.slice(0, Math.max(1, ownNumber.length - national.length));
      digits = code + national;
    }
    if (!groups && digits.length >= 9) {
      return [{ jid: `${digits}@s.whatsapp.net`, name: digits, isGroup: false, score: 100 }];
    }
    const wanted = normalizeName(query);
    if (!wanted) return [];
    const words = wanted.split(' ');
    const pool = groups
      ? [...this.groups.values()].map((g) => ({ jid: g.jid, labels: [g.name], name: g.name, isGroup: true }))
      : [...this.people.values()].map((p) => ({ jid: p.jid, labels: [p.name, p.notify].filter(Boolean), name: p.name || p.notify, isGroup: false }));

    const scored = [];
    for (const entry of pool) {
      let best = 0;
      for (const label of entry.labels) {
        const normal = normalizeName(label);
        if (!normal) continue;
        if (normal === wanted) best = Math.max(best, 100);
        else if (normal.startsWith(`${wanted} `) || normal.split(' ')[0] === wanted) best = Math.max(best, 80);
        else if (words.every((word) => normal.includes(word))) best = Math.max(best, 60);
      }
      if (best) scored.push({ jid: entry.jid, name: entry.name, isGroup: entry.isGroup, score: best });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ar'));
    const top = scored[0]?.score || 0;
    return scored.filter((entry) => entry.score === top).slice(0, limit);
  }
}
