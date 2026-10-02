import makeWASocket, { Browsers, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { destroyStoredAuthState, loadAuthState, listStoredUserIds } from './encrypted-auth-store.js';
import { isCustomerEligible } from './customer-access.js';

const sessions = new Map();
const retryTimers = new Map();
const creationLocks = new Map();
const MAX_RETRY_DELAY_MS = 60_000;

function publicStatus(session) {
  const qrIsCurrent = session?.qrExpiresAt && Date.parse(session.qrExpiresAt) > Date.now();
  return {
    status: session?.status || 'disconnected',
    qrDataUrl: session?.status === 'pending' && qrIsCurrent ? session.qrDataUrl || null : null,
    qrExpiresAt: session?.status === 'pending' && qrIsCurrent ? session.qrExpiresAt || null : null,
    phoneNumber: session?.status === 'connected' ? session.phoneNumber || null : null,
  };
}

async function writeEvent(admin, userId, connectionId, eventType, metadata = {}) {
  const { error } = await admin.from('whatsapp_connection_events').insert({
    user_id: userId,
    connection_id: connectionId,
    event_type: eventType,
    metadata,
  });
  if (error) throw new Error('EVENT_WRITE_FAILED');
}

async function setConnectionStatus(admin, userId, connectionId, status) {
  const { error } = await admin.from('whatsapp_connections')
    .update({ status })
    .eq('id', connectionId)
    .eq('user_id', userId)
    .eq('connection_type', 'qr');
  if (error) throw new Error('CONNECTION_STATUS_WRITE_FAILED');
}

async function ensureConnection(admin, userId, preferredId = null) {
  if (preferredId) {
    const { data, error } = await admin.from('whatsapp_connections')
      .select('id')
      .eq('id', preferredId)
      .eq('user_id', userId)
      .eq('connection_type', 'qr')
      .maybeSingle();
    if (error) throw new Error('CONNECTION_LOOKUP_FAILED');
    if (data?.id) return data.id;
  }

  const { data: existing, error: lookupError } = await admin.from('whatsapp_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('connection_type', 'qr')
    .limit(1)
    .maybeSingle();
  if (lookupError) throw new Error('CONNECTION_LOOKUP_FAILED');
  if (existing?.id) return existing.id;

  const { data, error } = await admin.from('whatsapp_connections')
    .insert({ user_id: userId, connection_type: 'qr', status: 'pending' })
    .select('id')
    .single();
  if (error || !data?.id) throw new Error('CONNECTION_CREATE_FAILED');
  await writeEvent(admin, userId, data.id, 'pending', { source: 'qr' });
  return data.id;
}

async function recordStatus(session, nextStatus, metadata = {}) {
  session.status = nextStatus;
  session.qrDataUrl = null;
  session.qrExpiresAt = null;
  await setConnectionStatus(session.admin, session.userId, session.connectionId, nextStatus);
  await writeEvent(session.admin, session.userId, session.connectionId, nextStatus, metadata);
}

function scheduleReconnect(session) {
  if (session.userRequestedDisconnect || session.status === 'needs_reauth') return;
  const retries = (session.retries || 0) + 1;
  session.retries = retries;
  const delay = Math.min(1000 * (2 ** Math.min(retries - 1, 6)), MAX_RETRY_DELAY_MS);
  recordStatus(session, 'reconnecting', { retry: retries }).catch(() => {});
  const oldTimer = retryTimers.get(session.userId);
  if (oldTimer) clearTimeout(oldTimer);
  retryTimers.set(session.userId, setTimeout(() => {
    retryTimers.delete(session.userId);
    isCustomerEligible(session.admin, session.userId).then(async (eligible) => {
      if (!eligible) {
        session.userRequestedDisconnect = true;
        await recordStatus(session, 'disconnected', { reason: 'account_not_active' });
        return;
      }
      try {
        await openSocket(session);
      } catch {
        if (!session.userRequestedDisconnect) scheduleReconnect(session);
      }
    }).catch(() => {
      recordStatus(session, 'error', { reason: 'account_check_failed' }).catch(() => {});
    });
  }, delay));
}

async function openSocket(session) {
  if (session.socket || session.opening) return publicStatus(session);
  session.opening = true;
  session.userRequestedDisconnect = false;
  try {
    const socket = makeWASocket({
      auth: { creds: session.authState.creds, keys: session.authState.keys },
      browser: Browsers.macOS('Smart.z'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      fireInitQueries: false,
      generateHighQualityLinkPreview: false,
    });
    session.socket = socket;
    socket.ev.on('creds.update', () => session.authState.saveCreds().catch(() => {}));
    socket.ev.on('connection.update', async (update) => {
      if (session.socket !== socket) return;
      if (update.qr) {
        try {
          session.status = 'pending';
          session.qrDataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
          session.qrExpiresAt = new Date(Date.now() + 45_000).toISOString();
          await setConnectionStatus(session.admin, session.userId, session.connectionId, 'pending');
              await writeEvent(session.admin, session.userId, session.connectionId, 'qr', { expires_in_seconds: 45 });
        } catch {
          session.status = 'error';
          session.qrDataUrl = null;
          await recordStatus(session, 'error', { reason: 'qr_generation_failed' }).catch(() => {});
        }
      }
      if (update.connection === 'open') {
        session.retries = 0;
        session.phoneNumber = socket.user?.id?.split(':')[0] || null;
        await recordStatus(session, 'connected', { phone_number: session.phoneNumber });
      }
      if (update.connection === 'close') {
        session.socket = null;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
          session.qrDataUrl = null;
          await recordStatus(session, 'needs_reauth', { reason: code === DisconnectReason.loggedOut ? 'logged_out' : 'invalid_auth' }).catch(() => {});
        } else if (!session.userRequestedDisconnect) {
          await recordStatus(session, 'disconnected', { reason: 'transport_closed' }).catch(() => {});
          scheduleReconnect(session);
        } else {
          await recordStatus(session, 'disconnected', { reason: 'user_disconnect' }).catch(() => {});
        }
      }
      if (update.connection === 'connecting' && session.status !== 'pending') {
        await recordStatus(session, 'reconnecting', { reason: 'socket_connecting' }).catch(() => {});
      }
    });
    return publicStatus(session);
  } catch (error) {
    session.socket = null;
    await recordStatus(session, 'error', { reason: 'socket_start_failed' }).catch(() => {});
    throw error;
  } finally {
    session.opening = false;
  }
}

async function createSessionInternal(userId, admin) {
  const active = sessions.get(userId);
  if (active) {
    if (active.status === 'needs_reauth') {
      await destroySession(userId, admin);
    } else {
      if (['connected', 'pending', 'reconnecting'].includes(active.status)) return publicStatus(active);
      return reconnectSession(userId, admin);
    }
  }

  const connectionId = await ensureConnection(admin, userId);
  let authState;
  try {
    authState = await loadAuthState(userId);
  } catch {
    await writeEvent(admin, userId, connectionId, 'needs_reauth', { reason: 'auth_state_unreadable' }).catch(() => {});
    await destroyStoredAuthState(userId);
    authState = await loadAuthState(userId);
  }
  await authState.setConnectionId(connectionId);
  await authState.saveCreds();
  const session = {
    userId,
    connectionId,
    authState,
    admin,
    status: authState.creds.registered ? 'reconnecting' : 'pending',
    qrDataUrl: null,
    qrExpiresAt: null,
    retries: 0,
    userRequestedDisconnect: false,
    socket: null,
    opening: false,
  };
  sessions.set(userId, session);
  await recordStatus(session, session.status, { source: 'qr' });
  await openSocket(session);
  return publicStatus(session);
}

export async function createSession(userId, admin) {
  const activeCreation = creationLocks.get(userId);
  if (activeCreation) return activeCreation;
  const creation = createSessionInternal(userId, admin);
  creationLocks.set(userId, creation);
  try {
    return await creation;
  } finally {
    if (creationLocks.get(userId) === creation) creationLocks.delete(userId);
  }
}

export async function restoreSession(userId, admin) {
  const current = sessions.get(userId);
  if (current) return publicStatus(current);
  const { data: connection, error } = await admin.from('whatsapp_connections')
    .select('id,status')
    .eq('user_id', userId)
    .eq('connection_type', 'qr')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('CONNECTION_LOOKUP_FAILED');
  if (!connection) return publicStatus(null);

  let authState;
  try {
    authState = await loadAuthState(userId);
  } catch {
    await setConnectionStatus(admin, userId, connection.id, 'needs_reauth');
    await writeEvent(admin, userId, connection.id, 'needs_reauth', { reason: 'auth_state_unreadable' }).catch(() => {});
    return { status: 'needs_reauth', qrDataUrl: null, qrExpiresAt: null, phoneNumber: null };
  }
  if (!authState.creds.registered) {
        const session = {
          userId,
          connectionId: connection.id,
          authState,
          admin,
          status: 'pending',
          qrDataUrl: null,
          qrExpiresAt: null,
          retries: 0,
          userRequestedDisconnect: false,
          socket: null,
          opening: false,
        };
        sessions.set(userId, session);
        await recordStatus(session, 'pending', { reason: 'pending_signup_restored' });
        await openSocket(session);
        return publicStatus(session);
  }

  const session = {
    userId,
    connectionId: connection.id,
    authState,
    admin,
    status: 'reconnecting',
    qrDataUrl: null,
    qrExpiresAt: null,
    retries: 0,
    userRequestedDisconnect: false,
    socket: null,
    opening: false,
  };
  sessions.set(userId, session);
  await recordStatus(session, 'reconnecting', { reason: 'service_restore' });
  await openSocket(session);
  return publicStatus(session);
}

export async function restoreAllSessions(admin) {
  const userIds = await listStoredUserIds();
  for (const userId of userIds) {
    if (!await isCustomerEligible(admin, userId)) continue;
    const { data: connection } = await admin.from('whatsapp_connections')
      .select('id,status')
      .eq('user_id', userId)
      .eq('connection_type', 'qr')
      .limit(1)
      .maybeSingle();
    if (!connection) continue;
    try {
      await restoreSession(userId, admin);
    } catch {
      await setConnectionStatus(admin, userId, connection.id, 'error').catch(() => {});
      await writeEvent(admin, userId, connection.id, 'error', { reason: 'restore_failed' }).catch(() => {});
    }
  }
}

export async function revalidateSessions(admin) {
  for (const session of sessions.values()) {
    if (session.userRequestedDisconnect) continue;
    if (!await isCustomerEligible(admin, session.userId)) {
      session.userRequestedDisconnect = true;
      const timer = retryTimers.get(session.userId);
      if (timer) clearTimeout(timer);
      retryTimers.delete(session.userId);
      const socket = session.socket;
      session.socket = null;
      socket?.end(undefined);
      await recordStatus(session, 'disconnected', { reason: 'account_not_active' }).catch(() => {});
    }
  }
}

export async function getStatus(userId, admin) {
  const session = sessions.get(userId);
  if (session) return publicStatus(session);
  return restoreSession(userId, admin);
}

export async function reconnectSession(userId, admin) {
  let session = sessions.get(userId);
  if (!session) {
    const restored = await restoreSession(userId, admin);
    session = sessions.get(userId);
    if (!session) return restored;
  }
  if (session.status === 'needs_reauth') return publicStatus(session);
  await recordStatus(session, 'reconnecting', { source: 'manual_reconnect' });
  await openSocket(session);
  return publicStatus(session);
}

export async function disconnectSession(userId, admin) {
  let session = sessions.get(userId);
  if (!session) {
    await restoreSession(userId, admin);
    session = sessions.get(userId);
  }
  if (!session) return getStatus(userId, admin);
  session.userRequestedDisconnect = true;
  const timer = retryTimers.get(userId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(userId);
  const socket = session.socket;
  session.socket = null;
  socket?.end(undefined);
  await recordStatus(session, 'disconnected', { reason: 'user_disconnect' });
  return publicStatus(session);
}

export async function destroySession(userId, admin) {
  let session = sessions.get(userId);
  if (!session) {
    const { data: connection, error } = await admin.from('whatsapp_connections')
      .select('id')
      .eq('user_id', userId)
      .eq('connection_type', 'qr')
      .limit(1)
      .maybeSingle();
    if (error) throw new Error('CONNECTION_LOOKUP_FAILED');
    if (connection?.id) {
      try {
        const authState = await loadAuthState(userId);
        session = { userId, connectionId: connection.id, authState, admin, socket: null, userRequestedDisconnect: true };
      } catch {
        await destroyStoredAuthState(userId);
        await admin.from('whatsapp_connection_events').insert({
          user_id: userId,
          connection_id: connection.id,
          event_type: 'destroyed',
          metadata: { source: 'user_request', reason: 'unreadable_auth_state' },
        });
        await admin.from('whatsapp_connections').delete()
          .eq('id', connection.id).eq('user_id', userId).eq('connection_type', 'qr');
        return publicStatus(null);
      }
    } else {
      await destroyStoredAuthState(userId);
      return publicStatus(null);
    }
  }

  if (session) {
    session.userRequestedDisconnect = true;
    const timer = retryTimers.get(userId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(userId);
    const socket = session.socket;
    session.socket = null;
    try { await socket?.logout(); } catch { socket?.end(undefined); }
    await session.authState.destroy();
    sessions.delete(userId);
    await admin.from('whatsapp_connection_events').insert({
      user_id: userId,
      connection_id: session.connectionId,
      event_type: 'destroyed',
      metadata: { source: 'user_request' },
    });
    await admin.from('whatsapp_connections').delete()
      .eq('id', session.connectionId).eq('user_id', userId).eq('connection_type', 'qr');
  }
  return publicStatus(null);
}