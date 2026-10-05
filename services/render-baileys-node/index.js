import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason 
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SMART_Z_APP_URL = (process.env.SMART_Z_APP_URL || 'https://smart-z.pages.dev').replace(/\/+$/, '');
const CLUSTER_NODE_KEY = process.env.CLUSTER_NODE_KEY || '';
const CLUSTER_NODE_ID = Number(process.env.CLUSTER_NODE_ID || 1);
const AUTH_DIR = path.join(process.cwd(), 'auth_info_baileys');

let qrCodeImage = null;
let connectionStatus = 'DISCONNECTED';
let sock = null;

// Deduplication cache to prevent reprocessing on reconnect
const processedMessageIds = new Map();
const DEDUPLICATION_TTL_MS = 5 * 60 * 1000;

function isDuplicate(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  if (processedMessageIds.has(messageId)) {
    return true;
  }
  processedMessageIds.set(messageId, now);

  // Clean old entries
  if (processedMessageIds.size > 2000) {
    for (const [id, time] of processedMessageIds.entries()) {
      if (now - time > DEDUPLICATION_TTL_MS) {
        processedMessageIds.delete(id);
      }
    }
  }
  return false;
}

// Helper: Extract text from any Baileys message type
function extractMessageText(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    null
  );
}

// Forward incoming message to Smart.z Assistant & send reply back
async function handleIncomingWhatsAppMessage(msg) {
  if (msg.key.fromMe) return; // Skip own messages
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) {
    return; // Skip status broadcasts and group messages
  }

  const messageId = msg.key.id;
  if (isDuplicate(messageId)) return;

  const text = extractMessageText(msg);
  if (!text || !text.trim()) return;

  const senderName = msg.pushName || 'العميل';
  console.log(`📩 [Node #${CLUSTER_NODE_ID}] رسالة واردة من (${senderName} / ${remoteJid}): ${text}`);

  try {
    // 1. Show Typing indicator
    if (sock) {
      await sock.sendPresenceUpdate('composing', remoteJid).catch(() => {});
    }

    // 2. Request Smart.z AI assistant reply
    const response = await fetch(`${SMART_Z_APP_URL}/api/whatsapp/cluster/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CLUSTER_NODE_KEY}`,
        'X-API-Key': CLUSTER_NODE_KEY,
      },
      body: JSON.stringify({
        nodeId: CLUSTER_NODE_ID,
        remoteJid,
        text: text.trim(),
        senderName,
        messageId,
        timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) : Math.floor(Date.now() / 1000),
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ [Node #${CLUSTER_NODE_ID}] Smart.z API Error (HTTP ${response.status}):`, errText);
      return;
    }

    const data = await response.json();
    if (data?.success && data?.reply) {
      console.log(`🤖 [Node #${CLUSTER_NODE_ID}] تم توليد الرد بنجاح، جارٍ الإرسال إلى: ${remoteJid}`);
      
      // 3. Send AI Reply via Baileys
      await sock.sendMessage(remoteJid, { text: data.reply });
    }
  } catch (error) {
    console.error(`❌ [Node #${CLUSTER_NODE_ID}] فشل معالجة رسالة الواتساب:`, error?.message || error);
  } finally {
    if (sock) {
      await sock.sendPresenceUpdate('paused', remoteJid).catch(() => {});
    }
  }
}

async function connectToWhatsApp() {
  connectionStatus = 'CONNECTING';
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '121.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeImage = await QRCode.toDataURL(qr);
    }

    if (connection === 'open') {
      connectionStatus = 'CONNECTED';
      qrCodeImage = null;
      console.log(`✅ [Node #${CLUSTER_NODE_ID}] تم فتح الجلسة والاتصال بـ WhatsApp بنجاح!`);
    }

    if (connection === 'close') {
      connectionStatus = 'DISCONNECTED';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`🔄 [Node #${CLUSTER_NODE_ID}] انقطع الاتصال، جارٍ إعادة المحاولة خلال 5 ثوان...`);
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log(`⚠️ [Node #${CLUSTER_NODE_ID}] تم تسجيل الخروج من الجلسة.`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const msg of messages) {
        if (!msg.key.fromMe && msg.message) {
          await handleIncomingWhatsAppMessage(msg);
        }
      }
    }
  });
}

// Endpoint: Connect via QR or Pairing Code
app.get('/api/connect', async (req, res) => {
  const { method, phoneNumber } = req.query;

  if (method === 'qr') {
    if (qrCodeImage) {
      return res.json({ success: true, type: 'qr', qr: qrCodeImage, status: connectionStatus });
    }
    return res.status(400).json({ success: false, error: 'رمز الـ QR غير جاهز بعد' });
  }

  if (method === 'pairing_code') {
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'يلزم توفير رقم الهاتف' });
    }

    try {
      const cleanNumber = phoneNumber.replace(/\D/g, '');
      const code = await sock.requestPairingCode(cleanNumber);

      return res.json({
        success: true,
        type: 'pairing_code',
        pairingCode: code,
        deepLink: `whatsapp://pairing-code?code=${code}`,
        status: connectionStatus,
      });
    } catch (error) {
      console.error('Pairing code error:', error);
      return res.status(500).json({ success: false, error: 'فشل استخراج رمز الاقتران' });
    }
  }

  return res.status(400).json({ success: false, error: 'طريقة الاتصال غير مدعومة' });
});

// Endpoint: Health & Status
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    nodeId: CLUSTER_NODE_ID,
    timestamp: new Date().toISOString(),
  });
});

// Endpoint: Send proactive message from Smart.z to user
app.post('/api/send', async (req, res) => {
  const authHeader = req.headers.authorization || req.headers['x-api-key'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (CLUSTER_NODE_KEY && token !== CLUSTER_NODE_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { remoteJid, text } = req.body || {};
  if (!remoteJid || !text) {
    return res.status(400).json({ success: false, error: 'Missing remoteJid or text' });
  }

  if (!sock || connectionStatus !== 'CONNECTED') {
    return res.status(503).json({ success: false, error: 'WhatsApp socket is not connected' });
  }

  try {
    await sock.sendMessage(remoteJid, { text });
    return res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ success: false, error: error?.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 خادم Baileys Node #${CLUSTER_NODE_ID} يعمل على المنفذ ${PORT}`);
  connectToWhatsApp();
});

