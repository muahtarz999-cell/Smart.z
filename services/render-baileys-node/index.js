/**
 * Smart.z WhatsApp node (personal path, Baileys).
 *
 * One node = one WhatsApp session = one customer. The Smart.z app decides
 * which customer owns the node; this service only keeps the session alive,
 * shows a QR / pairing code on demand, forwards incoming text to the app,
 * and wipes the session when the app asks (/api/reset).
 *
 * Every /api/* route requires CLUSTER_NODE_KEY. Only /healthz is public.
 */
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import pino from 'pino';
import QRCode from 'qrcode';
import { clearSupabaseAuthState, useSupabaseAuthState } from './supabase-auth-state.js';
import { ContactBook } from './contacts.js';
import { describeMessage, Inbox, MAX_INBOX_AGE_MS, unwrapMessage } from './inbox.js';
import { toVoiceNote } from './voice-note.js';
import { SentCache } from './sent-cache.js';
import { CallMonitor } from './call-monitor.js';

const PORT = Number(process.env.PORT || 3000);
const NODE_ID = Number(process.env.CLUSTER_NODE_ID || 0);
const NODE_KEY = (process.env.CLUSTER_NODE_KEY || '').trim();
const APP_URL = (process.env.SMART_Z_APP_URL || 'https://smart-z.pages.dev').replace(/\/+$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

const DEMAND_WINDOW_MS = 3 * 60 * 1000; // keep generating QR codes only while someone is waiting
const PAIRING_READY_TIMEOUT_MS = 25_000;
const MAX_MESSAGE_AGE_S = 120; // ignore backlog delivered after a reconnect
const RECONNECT_DELAY_MS = 3_000;
const MAX_VOICE_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_AUTO_REPLIES_PER_MINUTE = 8; // keeps the number far from WhatsApp's automation limits

if (!Number.isInteger(NODE_ID) || NODE_ID < 1 || NODE_ID > 5) {
  console.error('CLUSTER_NODE_ID must be 1..5');
  process.exit(1);
}
if (NODE_KEY.length < 24) {
  console.error('CLUSTER_NODE_KEY is missing or shorter than 24 characters');
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// AI receptionist: follows calls the app accepted with OpenAI (see call-monitor.js). Off without OPENAI_API_KEY.
const callMonitor = new CallMonitor({
  apiKey: (process.env.OPENAI_API_KEY || '').trim(),
  logger,
  report: async (payload) => {
    const response = await fetch(`${APP_URL}/api/receptionist/call-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NODE_KEY}` },
      body: JSON.stringify({ nodeId: NODE_ID, ...payload }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) logger.warn({ status: response.status }, 'call log not accepted');
  },
});

// Safe identifiers for logs: message id and the last 4 digits only, never content.
function maskJid(jid) {
  const [user = '', server = ''] = String(jid || '').split('@');
  return `…${user.split(':')[0].slice(-4)}@${server}`;
}

// ---------------------------------------------------------------- sessions (several customers per node)
// Each slot is one customer's WhatsApp session with its own socket, contacts,
// inbox and caches. Slot 0 is the session from before multi-customer support.
function createSession(slot) {
  const TAG = slot > 0 ? `${NODE_ID}/${slot}` : String(NODE_ID);
  const AUTH_DIR_FOR_SLOT = slot > 0 ? `${AUTH_DIR}_slot${slot}` : AUTH_DIR;
  const contacts = new ContactBook({ supabase, nodeId: NODE_ID, dir: process.cwd(), slot });
  const inbox = new Inbox(); // memory only: waits for the phone to collect, then dropped
  const sentMessages = new SentCache(); // answers recipients' retry requests (see sent-cache.js)

  // ---------------------------------------------------------------- state
  const node = {
    sock: null,
    generation: 0,
    starting: null,
    status: 'IDLE', // IDLE | STARTING | WAITING_QR | CONNECTING | CONNECTED | ERROR
    qr: null,
    qrAt: 0,
    phone: null,
    registered: false,
    lastDemandAt: 0,
    lastError: null,
    pairing: null, // { phone, code, at }
    qrWaiters: [],
  };

  function hasDemand() {
    return Date.now() - node.lastDemandAt < DEMAND_WINDOW_MS;
  }

  async function loadAuthState() {
    if (supabase) return useSupabaseAuthState(supabase, NODE_ID, slot);
    return useMultiFileAuthState(AUTH_DIR_FOR_SLOT);
  }

  async function clearSession() {
    if (supabase) await clearSupabaseAuthState(supabase, NODE_ID, slot);
    await fs.rm(AUTH_DIR_FOR_SLOT, { recursive: true, force: true });
    await contacts.clear();
    inbox.clear();
    sentMessages.clear();
    node.registered = false;
    node.phone = null;
    node.qr = null;
    node.pairing = null;
  }

  function closeSocket() {
    const sock = node.sock;
    node.sock = null;
    node.generation += 1; // events from the old socket are ignored from now on
    if (!sock) return;
    try { sock.ev.removeAllListeners(); } catch {}
    try { sock.end(undefined); } catch {}
  }

  function resolveQrWaiters() {
    const waiters = node.qrWaiters;
    node.qrWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitForSocketReady(timeoutMs) {
    if (node.qr || node.status === 'CONNECTED') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        node.qrWaiters = node.qrWaiters.filter((item) => item !== done);
        reject(new Error('SOCKET_NOT_READY'));
      }, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      node.qrWaiters.push(done);
    });
  }

  async function startSocket() {
    if (node.sock) return;
    if (node.starting) return node.starting;

    node.starting = (async () => {
      node.status = 'STARTING';
      node.lastError = null;
      const { state, saveCreds } = await loadAuthState();
      node.registered = Boolean(state.creds?.registered);
      await contacts.load().catch(() => {});

      let version;
      try {
        // An outdated WhatsApp Web version makes the server refuse the socket
        // (connection failure 405) before any QR is issued.
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        version = undefined; // fall back to the version bundled with Baileys
      }

      const generation = ++node.generation;
      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        // A recipient that cannot decrypt asks for the message again; without this
        // it stays on "Waiting for this message" forever.
        getMessage: async (key) => {
          const entry = sentMessages.get(key?.id);
          console.log(`[node ${TAG}] retry requested id=${key?.id} to=${maskJid(key?.remoteJid)} found=${Boolean(entry)} kind=${entry?.kind || '-'}`);
          return entry?.message;
        },
      });
      node.sock = sock;

      sock.ev.on('creds.update', async () => {
        try { await saveCreds(); } catch (error) { logger.error({ err: error }, 'saveCreds failed'); }
      });

      sock.ev.on('connection.update', async (update) => {
        if (generation !== node.generation) return;
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          node.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
          node.qrAt = Date.now();
          node.status = 'WAITING_QR';
          resolveQrWaiters();
        }
        if (connection === 'connecting' && !qr && node.status !== 'WAITING_QR') {
          node.status = 'CONNECTING';
        }
        if (connection === 'open') {
          node.status = 'CONNECTED';
          node.qr = null;
          node.pairing = null;
          node.registered = true;
          node.phone = (sock.user?.id || '').split(':')[0].split('@')[0] || null;
          resolveQrWaiters();
          sock.groupFetchAllParticipating()
            .then((groups) => contacts.setGroups(Object.values(groups || {})))
            .catch(() => {});
          console.log(`[node ${TAG}] connected as ${node.phone}`);
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          closeSocket();
          node.qr = null;
          node.pairing = null; // a pairing code belongs to the socket that issued it

          if (code === DisconnectReason.loggedOut) {
            // Unlinked from the phone: wipe the dead credentials so a new QR can be issued.
            console.log(`[node ${TAG}] logged out from the phone; clearing session`);
            await clearSession().catch((error) => logger.error({ err: error }, 'clearSession failed'));
            node.status = 'IDLE';
            if (hasDemand()) setTimeout(() => startSocket().catch(onStartError), RECONNECT_DELAY_MS);
            return;
          }

          // restartRequired (after a successful scan), timeouts and network drops land here.
          const keepAlive = node.registered || hasDemand();
          node.status = keepAlive ? 'CONNECTING' : 'IDLE';
          if (keepAlive) setTimeout(() => startSocket().catch(onStartError), RECONNECT_DELAY_MS);
        }
      });

      // Delivery evidence for what we sent: 2 server ack, 3 delivered, 4 read, 5 played.
      sock.ev.on('messages.update', (updates) => {
        for (const { key, update } of updates || []) {
          const kind = key?.fromMe ? sentMessages.kindOf(key.id) : undefined;
          if (kind && update?.status !== undefined) {
            console.log(`[node ${TAG}] status id=${key.id} kind=${kind} to=${maskJid(key.remoteJid)} status=${update.status}`);
          }
        }
      });

      sock.ev.on('call', (calls) => {
        for (const call of Array.isArray(calls) ? calls : []) {
          if (call?.status === 'offer') handleIncomingCall(call).catch((error) => logger.error({ err: error }, 'call handling failed'));
        }
      });
      sock.ev.on('contacts.upsert', (list) => contacts.upsert(list));
      sock.ev.on('contacts.update', (list) => contacts.upsert(list));
      sock.ev.on('messaging-history.set', ({ contacts: list }) => { if (list) contacts.upsert(list); });
      sock.ev.on('groups.upsert', (list) => contacts.addGroups(list));

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (generation !== node.generation) return;
        for (const message of messages) recordInbox(message);
        if (type !== 'notify') return;
        for (const message of messages) {
          await handleIncoming(message).catch((error) => logger.error({ err: error }, 'incoming message failed'));
        }
      });
    })();

    try {
      await node.starting;
    } finally {
      node.starting = null;
    }
  }

  function onStartError(error) {
    node.status = 'ERROR';
    node.lastError = error?.message || String(error);
    closeSocket();
    logger.error({ err: error }, 'socket start failed');
  }

  // ---------------------------------------------------------------- incoming messages
  function extractText(message) {
    const m = unwrapMessage(message.message);
    if (!m) return null;
    return m.conversation
      || m.extendedTextMessage?.text
      || m.imageMessage?.caption
      || m.videoMessage?.caption
      || m.documentMessage?.caption
      || null;
  }

  const seen = new Map();
  function alreadySeen(id) {
    if (!id) return false;
    const now = Date.now();
    if (seen.has(id)) return true;
    seen.set(id, now);
    if (seen.size > 2000) {
      for (const [key, at] of seen) if (now - at > 10 * 60 * 1000) seen.delete(key);
    }
    return false;
  }

  const recentReplies = [];
  function underReplyLimit() {
    const now = Date.now();
    while (recentReplies.length && now - recentReplies[0] > 60_000) recentReplies.shift();
    return recentReplies.length < MAX_AUTO_REPLIES_PER_MINUTE;
  }

  function senderNumberOf(message) {
    const key = message.key || {};
    const candidates = [key.senderPn, key.remoteJidAlt, key.participantPn, key.remoteJid];
    const phoneJid = candidates.find((jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net'));
    return (phoneJid || '').split('@')[0].split(':')[0] || null;
  }

  /** Keeps a copy for the phone's local report (memory only, see inbox.js). */
  function recordInbox(message) {
    try {
      const jid = message.key?.remoteJid;
      if (message.key?.fromMe || !jid || !message.key.id) return;
      if (jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
      const sentAt = Number(message.messageTimestamp || 0) * 1000 || Date.now();
      if (Date.now() - sentAt > MAX_INBOX_AGE_MS) return; // old history synced at link time
      const text = describeMessage(message);
      if (!text) return;
      const isGroup = jid.endsWith('@g.us');
      const senderJid = isGroup ? message.key.participant : jid;
      const person = senderJid ? contacts.people.get(senderJid) : null;
      inbox.add({
        id: message.key.id,
        chatJid: jid,
        chatName: isGroup ? (contacts.groups.get(jid)?.name || 'مجموعة') : '',
        senderName: person?.name || message.pushName || person?.notify || '',
        senderNumber: isGroup ? (String(senderJid || '').split('@')[0].split(':')[0] || null) : senderNumberOf(message),
        isGroup,
        text,
        sentAt,
      });
    } catch (error) {
      logger.error({ err: error }, 'inbox record failed');
    }
  }

  async function handleIncoming(message) {
    const jid = message.key?.remoteJid;
    if (message.key?.fromMe || !jid) return;
    if (jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter')) return;
    if (alreadySeen(message.key.id)) return;

    const sentAt = Number(message.messageTimestamp || 0);
    if (sentAt && Date.now() / 1000 - sentAt > MAX_MESSAGE_AGE_S) return;

    if (message.pushName) contacts.upsert([{ id: jid, notify: message.pushName }]);

    const audioMessage = unwrapMessage(message.message)?.audioMessage;
    const text = audioMessage ? null : extractText(message)?.trim();
    if (!audioMessage && !text) return;
    if (!underReplyLimit()) return;

    const sock = node.sock;
    let audio;
    if (audioMessage) {
      if (Number(audioMessage.fileLength || 0) > MAX_VOICE_NOTE_BYTES) return;
      const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: sock?.updateMediaMessage });
      audio = { data: Buffer.from(buffer).toString('base64'), mimetype: audioMessage.mimetype || 'audio/ogg; codecs=opus' };
    }

    const response = await fetch(`${APP_URL}/api/whatsapp/cluster/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NODE_KEY}` },
      body: JSON.stringify({
        nodeId: NODE_ID,
        slot,
        remoteJid: jid,
        senderNumber: senderNumberOf(message),
        text: text ? text.slice(0, 4000) : undefined,
        audio,
        messageId: message.key.id,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success || !data.reply) {
      // auto-reply off, not allowed, nothing to say, or the app failed: say which, without content.
      if (!response.ok || !data?.success) logger.warn({ status: response.status, code: data?.error || null }, 'app gave no reply');
      return;
    }

    const current = node.sock;
    if (!current || node.status !== 'CONNECTED') return;
    recentReplies.push(Date.now());
    await current.readMessages([message.key]).catch(() => {});

    if (Array.isArray(data.voice) && data.voice.length) {
      try {
        await current.sendPresenceUpdate('recording', jid).catch(() => {});
        const ogg = await toVoiceNote(data.voice.map((part) => Buffer.from(part.data, 'base64')));
        console.log(`[node ${TAG}] voice converted parts=${data.voice.length} bytes=${ogg.length}`);
        const sentVoice = await current.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        sentMessages.remember(sentVoice, 'voice');
        console.log(`[node ${TAG}] voice handed to WhatsApp id=${sentVoice?.key?.id} to=${maskJid(jid)}`);
        await current.sendPresenceUpdate('paused', jid).catch(() => {});
        return;
      } catch (error) {
        logger.error({ err: error }, 'voice reply failed; sending text');
      }
    }

    await current.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 800 + data.reply.length * 25))); // human pace
    sentMessages.remember(await current.sendMessage(jid, { text: data.reply }), 'text');
    await current.sendPresenceUpdate('paused', jid).catch(() => {});
  }

  // ---------------------------------------------------------------- WhatsApp calls (2026-10-22)
  // The app decides (call rules + driving mode); the node rejects and sends the message.
  // The same caller gets the message at most once per CALL_MESSAGE_COOLDOWN_MS (people redial).
  const CALL_MESSAGE_COOLDOWN_MS = 10 * 60 * 1000;
  const lastCallMessage = new Map(); // jid → time

  async function handleIncomingCall(call) {
    const from = call.from;
    if (!from || call.isGroup) return;

    const response = await fetch(`${APP_URL}/api/whatsapp/cluster/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NODE_KEY}` },
      body: JSON.stringify({ nodeId: NODE_ID, slot }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success || data.reject !== true) return; // the phone rings as usual

    const sock = node.sock;
    if (!sock || node.status !== 'CONNECTED') return;
    await sock.rejectCall(call.id, from);
    console.log(`[node ${TAG}] call rejected from=${maskJid(from)} video=${call.isVideo === true}`);

    const person = contacts.people.get(from);
    inbox.add({
      id: `call-${call.id}`,
      chatJid: from,
      chatName: '',
      senderName: person?.name || person?.notify || '',
      senderNumber: from.endsWith('@s.whatsapp.net') ? from.split('@')[0].split(':')[0] : null,
      isGroup: false,
      text: `📞 مكالمة واتساب${call.isVideo ? ' فيديو' : ''} رُفضت تلقائيًا${data.message ? '، وأُرسلت رسالة' : ''}`,
      sentAt: Date.now(),
    });

    const now = Date.now();
    if (!data.message || now - (lastCallMessage.get(from) || 0) < CALL_MESSAGE_COOLDOWN_MS || !underReplyLimit()) return;
    lastCallMessage.set(from, now);
    for (const [jid, at] of lastCallMessage) if (now - at > CALL_MESSAGE_COOLDOWN_MS) lastCallMessage.delete(jid);
    recentReplies.push(now);
    sentMessages.remember(await sock.sendMessage(from, { text: String(data.message).slice(0, 300) }), 'text');
  }


  function publicStatus() {
    return {
      nodeId: NODE_ID,
      slot,
      status: node.status,
      connected: node.status === 'CONNECTED',
      phone: node.phone,
      hasQr: Boolean(node.qr),
      registered: node.registered,
      sessionStore: supabase ? 'supabase' : 'disk',
      error: node.lastError,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    slot,
    node,
    contacts,
    inbox,
    sentMessages,
    loadAuthState,
    clearSession,
    closeSocket,
    startSocket,
    waitForSocketReady,
    onStartError,
    publicStatus,
  };
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' })); // documents sent from the app arrive as base64

app.get('/healthz', (_req, res) => res.json({ ok: true }));

function tokenMatches(token) {
  const left = Buffer.from(String(token || ''));
  const right = Buffer.from(NODE_KEY);
  return left.length === right.length && timingSafeEqual(left, right);
}

app.use('/api', (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '') || req.get('x-api-key') || '';
  if (!tokenMatches(token)) return res.status(401).json({ success: false, error: 'UNAUTHORIZED' });
  next();
});


// ---------------------------------------------------------------- slots
// How many customers this node may host (the app decides who gets which slot).
const MAX_SLOTS = Math.min(20, Math.max(1, Number(process.env.CLUSTER_NODE_SLOTS || 10)));
const sessions = new Map(); // slot → session

function getSession(slot) {
  if (!sessions.has(slot)) sessions.set(slot, createSession(slot));
  return sessions.get(slot);
}

/** The slot of a request (?slot= or body.slot); slot 0 when absent, for apps from before slots. */
function slotOf(req) {
  const raw = req.query?.slot ?? req.body?.slot ?? 0;
  const slot = Number(raw);
  return Number.isInteger(slot) && slot >= 0 && slot < MAX_SLOTS ? slot : null;
}

function withSession(handler) {
  return (req, res) => {
    const slot = slotOf(req);
    if (slot === null) return res.status(400).json({ success: false, error: 'INVALID_SLOT' });
    return handler(getSession(slot), req, res);
  };
}

app.get('/api/status', withSession((session, _req, res) => res.json(session.publicStatus())));

// Every slot at a glance (admin / health checks). No phone numbers, only status.
app.get('/api/sessions', (_req, res) => res.json({
  success: true,
  nodeId: NODE_ID,
  maxSlots: MAX_SLOTS,
  sessions: [...sessions.values()].map((session) => ({
    slot: session.slot,
    status: session.node.status,
    connected: session.node.status === 'CONNECTED',
    registered: session.node.registered,
  })),
  memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
}));

app.get('/api/connect', withSession(async (session, req, res) => {
  const { node } = session;
  node.lastDemandAt = Date.now();
  const method = String(req.query.method || 'qr');

  try {
    if (node.status === 'CONNECTED') return res.json({ success: true, ...session.publicStatus() });

    if (method === 'qr') {
      await session.startSocket();
      if (node.qr) return res.json({ success: true, type: 'qr', qr: node.qr, qrAt: node.qrAt, ...session.publicStatus() });
      // Not an error: the socket is still handshaking (normal right after a cold start).
      return res.status(202).json({ success: true, pending: true, ...session.publicStatus() });
    }

    if (method === 'pairing_code') {
      const phone = String(req.query.phoneNumber || '').replace(/\D/g, '');
      if (phone.length < 9 || phone.length > 15) {
        return res.status(400).json({ success: false, error: 'رقم الهاتف غير صالح؛ اكتبه مع رمز الدولة بدون صفر أو +.' });
      }
      if (node.registered) {
        return res.status(409).json({ success: false, error: 'هذا الخادم مرتبط بجلسة قائمة. افصل الربط أولاً.' });
      }
      if (node.pairing && node.pairing.phone === phone && Date.now() - node.pairing.at < 60_000) {
        return res.json({ success: true, type: 'pairing_code', pairingCode: node.pairing.code, ...session.publicStatus() });
      }
      await session.startSocket();
      await session.waitForSocketReady(PAIRING_READY_TIMEOUT_MS);
      const raw = await node.sock.requestPairingCode(phone);
      const code = String(raw).replace(/(.{4})(?=.)/, '$1-');
      node.pairing = { phone, code, at: Date.now() };
      return res.json({ success: true, type: 'pairing_code', pairingCode: code, ...session.publicStatus() });
    }

    return res.status(400).json({ success: false, error: 'طريقة الربط غير مدعومة.' });
  } catch (error) {
    logger.error({ err: error }, 'connect failed');
    const notReady = error?.message === 'SOCKET_NOT_READY';
    return res.status(notReady ? 202 : 500).json({
      success: notReady,
      pending: notReady,
      error: notReady ? undefined : 'تعذر تجهيز الربط على الخادم.',
      ...session.publicStatus(),
    });
  }
}));

// The phone collects waiting messages, stores them locally, then confirms.
// connected=false right after a cold start: the socket is still catching up,
// so an empty list does not mean "no messages".
app.get('/api/inbox', withSession((session, _req, res) => res.json({
  success: true,
  connected: session.node.status === 'CONNECTED',
  items: session.inbox.list(),
})));

app.post('/api/inbox/ack', withSession((session, req, res) => {
  const removed = session.inbox.ack(req.body?.ids);
  res.json({ success: true, removed });
}));

// Wipe one slot's session completely. Called by the app when a customer unlinks
// and before a slot is handed to a new customer. Other slots are untouched.
app.post('/api/reset', withSession(async (session, _req, res) => {
  const { node } = session;
  try {
    const sock = node.sock;
    if (sock && node.status === 'CONNECTED') {
      await sock.logout().catch(() => {});
    }
    session.closeSocket();
    await session.clearSession();
    node.status = 'IDLE';
    node.lastDemandAt = 0;
    return res.json({ success: true, ...session.publicStatus() });
  } catch (error) {
    logger.error({ err: error }, 'reset failed');
    return res.status(500).json({ success: false, error: 'RESET_FAILED' });
  }
}));

// The app accepted an AI-receptionist call and asks this node to follow it.
app.post('/api/calls/monitor', (req, res) => {
  const { callId, userId, channel, callerNumber, transferNumber } = req.body || {};
  if (typeof callId !== 'string' || !callId || callId.length > 120 || typeof userId !== 'string') {
    return res.status(400).json({ success: false, error: 'INVALID_CALL' });
  }
  if (!callMonitor.enabled) return res.status(503).json({ success: false, error: 'OPENAI_NOT_CONFIGURED' });
  const started = callMonitor.follow({
    callId,
    userId,
    channel: channel === 'whatsapp' ? 'whatsapp' : 'phone',
    callerNumber: String(callerNumber || '').replace(/\D/g, '').slice(0, 15),
    transferNumber: String(transferNumber || '').replace(/\D/g, '').slice(0, 15),
  });
  console.log(`[node ${NODE_ID}] receptionist call ${started ? 'followed' : 'skipped'}`);
  return res.json({ success: started });
});

// Contact lookup for voice commands ("send Ahmad ..."). Groups only when asked for explicitly.
app.get('/api/contacts/search', withSession((session, req, res) => {
  const query = String(req.query.q || '').slice(0, 80);
  const groups = req.query.groups === '1';
  return res.json({ success: true, matches: session.contacts.search(query, { groups, limit: 5, ownNumber: session.node.phone || '' }) });
}));

app.post('/api/send', withSession(async (session, req, res) => {
  const { node, sentMessages } = session;
  const TAG = session.slot > 0 ? `${NODE_ID}/${session.slot}` : String(NODE_ID);
  const { remoteJid, text, document, voice } = req.body || {};
  const hasText = typeof text === 'string' && text.trim();
  const hasDocument = document && typeof document.data === 'string';
  const voiceParts = Array.isArray(voice) ? voice.filter((part) => typeof part?.data === 'string').slice(0, 20) : [];
  if (typeof remoteJid !== 'string' || (!hasText && !hasDocument)) {
    return res.status(400).json({ success: false, error: 'Missing remoteJid, text or document' });
  }
  if (!node.sock || node.status !== 'CONNECTED') {
    return res.status(503).json({ success: false, error: 'NOT_CONNECTED' });
  }
  let voiceError = null;
  try {
    if (voiceParts.length && !hasDocument) {
      // A voice message the user asked for: the cloud voice reading the text, as a real voice note.
      try {
        await node.sock.sendPresenceUpdate('recording', remoteJid).catch(() => {});
        const ogg = await toVoiceNote(voiceParts.map((part) => Buffer.from(part.data, 'base64')));
        console.log(`[node ${TAG}] voice converted parts=${voiceParts.length} bytes=${ogg.length}`);
        const sentVoice = await node.sock.sendMessage(remoteJid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        sentMessages.remember(sentVoice, 'voice');
        console.log(`[node ${TAG}] voice handed to WhatsApp id=${sentVoice?.key?.id} to=${maskJid(remoteJid)}`);
        await node.sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
        return res.json({ success: true, voice: true, messageId: sentVoice?.key?.id || null });
      } catch (error) {
        logger.error({ err: error }, 'voice send failed; sending text');
        voiceError = String(error?.message || 'VOICE_FAILED').slice(0, 160);
      }
    }
    await node.sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
    const sent = hasDocument
      ? await node.sock.sendMessage(remoteJid, {
        document: Buffer.from(document.data, 'base64'),
        fileName: String(document.fileName || 'document').slice(0, 120),
        mimetype: String(document.mimetype || 'application/octet-stream'),
        caption: hasText ? text.slice(0, 1024) : undefined,
      })
      : await node.sock.sendMessage(remoteJid, { text: text.slice(0, 4096) });
    sentMessages.remember(sent, hasDocument ? 'document' : 'text');
    await node.sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    return res.json({ success: true, voice: false, voiceError, messageId: sent?.key?.id || null });
  } catch (error) {
    logger.error({ err: error }, 'send failed');
    return res.status(500).json({ success: false, error: error?.message || 'SEND_FAILED' });
  }
}));

app.listen(PORT, async () => {
  console.log(`[node ${NODE_ID}] listening on ${PORT}; slots: ${MAX_SLOTS}; session store: ${supabase ? 'supabase' : 'disk'}`);
  // Reconnect automatically every slot that already has a linked session.
  for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
    const session = getSession(slot);
    try {
      const { state } = await session.loadAuthState();
      if (state.creds?.registered) await session.startSocket();
      else sessions.delete(slot); // empty slots are created again on demand
    } catch (error) {
      session.onStartError(error);
    }
  }
});
