/**
 * Waiting room for incoming messages on their way to the customer's phone.
 *
 * Nothing here is written to disk or to Supabase: messages wait in memory
 * until the app collects them (GET /api/inbox) and confirms (POST
 * /api/inbox/ack), then they are dropped. The phone keeps its own copy and
 * deletes it after the retention period it chooses. A restart, an unlink or
 * a message older than MAX_AGE_MS empties the room.
 */

export const MAX_INBOX_ITEMS = 500;
export const MAX_INBOX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_TEXT = 2000;

const MEDIA_LABELS = {
  imageMessage: 'صورة',
  videoMessage: 'فيديو',
  audioMessage: 'رسالة صوتية',
  documentMessage: 'مستند',
  documentWithCaptionMessage: 'مستند',
  stickerMessage: 'ملصق',
  locationMessage: 'موقع',
  liveLocationMessage: 'موقع مباشر',
  contactMessage: 'جهة اتصال',
  contactsArrayMessage: 'جهات اتصال',
  pollCreationMessage: 'تصويت',
  pollCreationMessageV3: 'تصويت',
};

// Disappearing-message chats, view-once media and edits wrap the real content;
// without unwrapping, every message in such a chat was dropped as "noise".
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];

export function unwrapMessage(content) {
  let m = content;
  for (let depth = 0; m && depth < 5; depth++) {
    const wrapper = WRAPPERS.find((key) => m[key]?.message);
    if (!wrapper) break;
    m = m[wrapper].message;
  }
  return m || null;
}

/** Text of a message, or a label for media ("صورة: caption"). Null for protocol noise. */
export function describeMessage(message) {
  const m = unwrapMessage(message?.message);
  if (!m) return null;
  const text = m.conversation || m.extendedTextMessage?.text || '';
  if (text.trim()) return text.trim().slice(0, MAX_TEXT);
  for (const [field, label] of Object.entries(MEDIA_LABELS)) {
    if (!m[field]) continue;
    const caption = m[field].caption || m[field].message?.documentMessage?.caption || m[field].fileName || '';
    return caption ? `${label}: ${String(caption).trim().slice(0, MAX_TEXT)}` : label;
  }
  return null;
}

export class Inbox {
  constructor({ maxItems = MAX_INBOX_ITEMS, maxAgeMs = MAX_INBOX_AGE_MS } = {}) {
    this.maxItems = maxItems;
    this.maxAgeMs = maxAgeMs;
    this.items = new Map(); // id -> item, in arrival order
  }

  prune(now = Date.now()) {
    for (const [id, item] of this.items) {
      if (now - item.receivedAt > this.maxAgeMs) this.items.delete(id);
    }
    while (this.items.size > this.maxItems) this.items.delete(this.items.keys().next().value);
  }

  /** item: { id, chatJid, chatName, senderName, senderNumber, isGroup, text, sentAt } */
  add(item, now = Date.now()) {
    if (!item?.id || !item.text || this.items.has(item.id)) return false;
    this.items.set(item.id, { ...item, receivedAt: now });
    this.prune(now);
    return true;
  }

  list(now = Date.now()) {
    this.prune(now);
    return [...this.items.values()];
  }

  ack(ids = []) {
    let removed = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      if (this.items.delete(String(id))) removed += 1;
    }
    return removed;
  }

  clear() {
    this.items.clear();
  }
}
