import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import {
  createSession,
  destroySession,
  disconnectSession,
  getStatus,
  reconnectSession,
  revalidateSessions,
  restoreAllSessions,
} from './session-manager.js';
import { authenticateRequest } from './customer-access.js';

const port = Number(process.env.PORT || 8788);
const allowedOrigin = process.env.SMARTZ_ORIGIN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!allowedOrigin || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
  throw new Error('SMARTZ_ORIGIN and server-side Supabase environment variables are required.');
}

const authClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 32_768) reject(new Error('BODY_TOO_LARGE'));
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('INVALID_JSON')); }
    });
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin !== allowedOrigin) {
    response.writeHead(403, { 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/health' && request.method === 'GET') {
    sendJson(response, 200, { status: 'ok' }, allowedOrigin);
    return;
  }

  let access;
  try { access = await authenticateRequest(request, authClient, adminClient); } catch {
    access = { ok: false, status: 503, error: 'ACCESS_CHECK_FAILED' };
  }
  if (!access.ok) {
    sendJson(response, access.status, { error: access.error }, allowedOrigin);
    return;
  }
  const userId = access.userId;

  try {
    let result;
    if (url.pathname === '/api/whatsapp/status' && request.method === 'GET') {
      result = await getStatus(userId, adminClient);
    } else if (url.pathname === '/api/whatsapp/session' && request.method === 'POST') {
      await readJson(request);
      result = await createSession(userId, adminClient);
    } else if (url.pathname === '/api/whatsapp/reconnect' && request.method === 'POST') {
      await readJson(request);
      result = await reconnectSession(userId, adminClient);
    } else if (url.pathname === '/api/whatsapp/disconnect' && request.method === 'POST') {
      await readJson(request);
      result = await disconnectSession(userId, adminClient);
    } else if (url.pathname === '/api/whatsapp/session' && request.method === 'DELETE') {
      result = await destroySession(userId, adminClient);
    } else {
      sendJson(response, 404, { error: 'NOT_FOUND' }, allowedOrigin);
      return;
    }
    sendJson(response, 200, result, allowedOrigin);
  } catch (error) {
    const status = error.message === 'BODY_TOO_LARGE' ? 413 : error.message === 'INVALID_JSON' ? 400 : 500;
    sendJson(response, status, { error: 'WHATSAPP_SESSION_OPERATION_FAILED' }, allowedOrigin);
  }
});

await restoreAllSessions(adminClient);
server.listen(port, '0.0.0.0');
const customerAccessMonitor = setInterval(() => {
  revalidateSessions(adminClient).catch(() => {});
}, 60_000);
customerAccessMonitor.unref();