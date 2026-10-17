/**
 * Recently sent messages, kept in memory so Baileys can answer a recipient's
 * retry request. When a phone cannot decrypt a message it asks the sender to
 * send it again; Baileys looks the message up through `getMessage`. Without
 * this cache the lookup returns nothing and the recipient is left on
 * "Waiting for this message" for good.
 */
export const SENT_CACHE_LIMIT = 500;
export const SENT_CACHE_TTL_MS = 30 * 60 * 1000;

export class SentCache {
  constructor({ limit = SENT_CACHE_LIMIT, ttlMs = SENT_CACHE_TTL_MS, now = () => Date.now() } = {}) {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.now = now;
    this.items = new Map(); // id -> { message, at, kind }
  }

  /** Stores the proto of a message returned by sock.sendMessage. */
  remember(sent, kind = 'text') {
    const id = sent?.key?.id;
    if (!id || !sent.message) return;
    this.items.delete(id);
    this.items.set(id, { message: sent.message, at: this.now(), kind });
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value);
  }

  /** Returns the stored entry, or undefined when unknown or expired. */
  get(id) {
    const entry = id ? this.items.get(id) : undefined;
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.items.delete(id);
      return undefined;
    }
    return entry;
  }

  kindOf(id) {
    return this.get(id)?.kind;
  }

  clear() {
    this.items.clear();
  }
}
