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
  if (supabase) return useSupabaseAuthState(supabase, NODE_ID);
  return useMultiFileAuthState(AUTH_DIR);
}

async function clearSession() {
  if (supabase) await clearSupabaseAuthState(supabase, NODE_ID);
  await fs.rm(AUTH_DIR, { recursive: true, force: true });
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
    });
    node.sock = sock;

    sock.ev.on('creds.update', async () => {
      try { await saveCreds(); } catch (error) { logger.error({ error }, 'saveCreds failed'); }
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
        console.log(`[node ${NODE_ID}] connected as ${node.phone}`);
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        closeSocket();
        node.qr = null;
        node.pairing = null; // a pairing code belongs to the socket that issued it

        if (code === DisconnectReason.loggedOut) {
          // Unlinked from the phone: wipe the dead credentials so a new QR can be issued.
          console.log(`[node ${NODE_ID}] logged out from the phone; clearing session`);
          await clearSession().catch((error) => logger.error({ error }, 'clearSession failed'));
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (generation !== node.generation || type !== 'notify') return;
      for (const message of messages) {
        await handleIncoming(message).catch((error) => logger.error({ error }, 'incoming message failed'));
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
  logger.error({ error }, 'socket start failed');
}

// ---------------------------------------------------------------- incoming messages
function extractText(message) {
  const m = message.message;
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

async function handleIncoming(message) {
  const jid = message.key?.remoteJid;
  if (message.key?.fromMe || !jid) return;
  if (jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter')) return;
  if (alreadySeen(message.key.id)) return;

  const sentAt = Number(message.messageTimestamp || 0);
  if (sentAt && Date.now() / 1000 - sentAt > MAX_MESSAGE_AGE_S) return;

  const text = extractText(message)?.trim();
  if (!text) return;

  const response = await fetch(`${APP_URL}/api/whatsapp/cluster/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NODE_KEY}` },
    body: JSON.stringify({ nodeId: NODE_ID, remoteJid: jid, text: text.slice(0, 4000), messageId: message.key.id }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success || !data.reply) return; // auto-reply off, or nothing to say

  const sock = node.sock;
  if (!sock || node.status !== 'CONNECTED') return;
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await sock.sendMessage(jid, { text: data.reply });
  await sock.sendPresenceUpdate('paused', jid).catch(() => {});
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

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

function publicStatus() {
  return {
    nodeId: NODE_ID,
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

app.get('/api/status', (_req, res) => res.json(publicStatus()));

app.get('/api/connect', async (req, res) => {
  node.lastDemandAt = Date.now();
  const method = String(req.query.method || 'qr');

  try {
    if (node.status === 'CONNECTED') return res.json({ success: true, ...publicStatus() });

    if (method === 'qr') {
      await startSocket();
      if (node.qr) return res.json({ success: true, type: 'qr', qr: node.qr, qrAt: node.qrAt, ...publicStatus() });
      // Not an error: the socket is still handshaking (normal right after a cold start).
      return res.status(202).json({ success: true, pending: true, ...publicStatus() });
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
        return res.json({ success: true, type: 'pairing_code', pairingCode: node.pairing.code, ...publicStatus() });
      }
      await startSocket();
      await waitForSocketReady(PAIRING_READY_TIMEOUT_MS);
      const raw = await node.sock.requestPairingCode(phone);
      const code = String(raw).replace(/(.{4})(?=.)/, '$1-');
      node.pairing = { phone, code, at: Date.now() };
      return res.json({ success: true, type: 'pairing_code', pairingCode: code, ...publicStatus() });
    }

    return res.status(400).json({ success: false, error: 'طريقة الربط غير مدعومة.' });
  } catch (error) {
    logger.error({ error }, 'connect failed');
    const notReady = error?.message === 'SOCKET_NOT_READY';
    return res.status(notReady ? 202 : 500).json({
      success: notReady,
      pending: notReady,
      error: notReady ? undefined : 'تعذر تجهيز الربط على الخادم.',
      ...publicStatus(),
    });
  }
});

// Wipe the session completely. Called by the app when a customer unlinks and
// before a node is handed to a new customer.
app.post('/api/reset', async (_req, res) => {
  try {
    const sock = node.sock;
    if (sock && node.status === 'CONNECTED') {
      await sock.logout().catch(() => {});
    }
    closeSocket();
    await clearSession();
    node.status = 'IDLE';
    node.lastDemandAt = 0;
    return res.json({ success: true, ...publicStatus() });
  } catch (error) {
    logger.error({ error }, 'reset failed');
    return res.status(500).json({ success: false, error: 'RESET_FAILED' });
  }
});

app.post('/api/send', async (req, res) => {
  const { remoteJid, text } = req.body || {};
  if (typeof remoteJid !== 'string' || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ success: false, error: 'Missing remoteJid or text' });
  }
  if (!node.sock || node.status !== 'CONNECTED') {
    return res.status(503).json({ success: false, error: 'NOT_CONNECTED' });
  }
  try {
    await node.sock.sendMessage(remoteJid, { text: text.slice(0, 4096) });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error?.message || 'SEND_FAILED' });
  }
});

app.listen(PORT, async () => {
  console.log(`[node ${NODE_ID}] listening on ${PORT}; session store: ${supabase ? 'supabase' : 'disk'}`);
  // Reconnect automatically only if a linked session already exists.
  try {
    const { state } = await loadAuthState();
    if (state.creds?.registered) await startSocket();
  } catch (error) {
    onStartError(error);
  }
});
