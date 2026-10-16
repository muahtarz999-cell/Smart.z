/**
 * WhatsApp personal path: assignment of customers to the Render nodes.
 *
 * One node holds one WhatsApp session, so one node belongs to one customer.
 * The database (claim_whatsapp_cluster_node) is the only place that decides
 * ownership; there is no in-memory fallback, because a fallback can put two
 * customers on the same session.
 */
import { createClient } from '@supabase/supabase-js';

const NODE_COUNT = 5;

export function getConfiguredClusterNodes() {
  const nodes = [];
  for (let id = 1; id <= NODE_COUNT; id += 1) {
    const url = process.env[`RENDER_SERVER_${id}_URL`]?.trim();
    const key = process.env[`RENDER_SERVER_${id}_KEY`]?.trim();
    if (url && key) nodes.push({ id, url: url.replace(/\/+$/, ''), key });
  }
  return nodes;
}

export function getClusterNode(id) {
  return getConfiguredClusterNodes().find((node) => node.id === Number(id)) || null;
}

export class ClusterError extends Error {
  constructor(code, status = 500) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Calls a node's authenticated API. Never throws on HTTP status; throws on network/timeout. */
export async function callNode(node, pathname, { method = 'GET', query = {}, body, timeoutMs = 15_000 } = {}) {
  const url = new URL(pathname, `${node.url}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${node.key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

async function isNodeAwake(node) {
  try {
    const response = await fetch(`${node.url}/healthz`, { signal: AbortSignal.timeout(4_000), cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getUserAssignment(userId, client) {
  const { data, error } = await client
    .from('whatsapp_tenant_nodes')
    .select('*') // '*' so a missing optional column (migration not yet applied) does not break the lookup
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new ClusterError('ASSIGNMENT_LOOKUP_FAILED', 503);
  return data || null;
}

/** Wipes any session left on a node. Called before a node is handed to a new customer and on release. */
export async function resetNode(node) {
  const result = await callNode(node, '/api/reset', { method: 'POST', timeoutMs: 60_000 });
  if (!result.ok) throw new ClusterError('NODE_RESET_FAILED', 502);
}

export async function allocateNode(client, userId) {
  const nodes = getConfiguredClusterNodes();
  if (!nodes.length) throw new ClusterError('NO_CLUSTER_NODES_CONFIGURED', 503);

  // Fast path for the polling loop: an existing assignment needs no health checks.
  if (userId) {
    const existing = await getUserAssignment(userId, client);
    const existingNode = existing ? getClusterNode(existing.node_id) : null;
    if (existingNode) return { node: existingNode, isNew: false };
  }

  // Awake nodes first so the customer does not wait for a cold start; asleep ones still qualify.
  const awake = await Promise.all(nodes.map(isNodeAwake));
  const ordered = [...nodes.filter((_, i) => awake.at(i)), ...nodes.filter((_, i) => !awake.at(i))];

  const { data, error } = await client.rpc('claim_whatsapp_cluster_node', {
    p_candidates: ordered.map(({ id, url }) => ({ id, url })),
  });
  if (error) throw new ClusterError('CLAIM_FAILED', 503);
  if (!data?.success) {
    if (data?.error === 'ALL_CLUSTER_NODES_OCCUPIED') throw new ClusterError('ALL_CLUSTER_NODES_OCCUPIED', 503);
    if (data?.error === 'CUSTOMER_INACTIVE') throw new ClusterError('CUSTOMER_INACTIVE', 403);
    throw new ClusterError('CLAIM_FAILED', 503);
  }

  const node = getClusterNode(data.node_id);
  if (!node) throw new ClusterError('ASSIGNED_NODE_NOT_CONFIGURED', 503);

  if (data.is_new) {
    try {
      await resetNode(node);
    } catch (resetError) {
      // Never hand over a node that may still hold someone else's session.
      await client.rpc('release_whatsapp_cluster_node').catch(() => {});
      throw resetError;
    }
  }
  return { node, isNew: Boolean(data.is_new) };
}

export async function releaseNode(client) {
  const { data: nodeId, error } = await client.rpc('release_whatsapp_cluster_node');
  if (error) throw new ClusterError('RELEASE_FAILED', 503);
  const node = nodeId ? getClusterNode(nodeId) : null;
  if (node) await resetNode(node);
  return { released: Boolean(nodeId), nodeId: nodeId || null };
}

/**
 * Admin panel: frees a customer's node (suspend, delete, disconnect) with the service role.
 * The row goes first, so the node is free even if its wipe fails; the next claim wipes it again.
 */
export async function releaseNodeForUser(service, userId) {
  const { data, error } = await service
    .from('whatsapp_tenant_nodes')
    .delete()
    .eq('user_id', userId)
    .select('node_id');
  if (error) throw new ClusterError('RELEASE_FAILED', 503);
  const nodeId = data?.[0]?.node_id || null;
  const node = nodeId ? getClusterNode(nodeId) : null;
  let nodeWiped = !node;
  if (node) {
    try {
      await resetNode(node);
      nodeWiped = true;
    } catch {
      nodeWiped = false;
    }
  }
  return { released: Boolean(nodeId), nodeId, nodeWiped };
}

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const CLUSTER_MESSAGES = {
  NO_CLUSTER_NODES_CONFIGURED: 'خوادم WhatsApp غير مضبوطة في بيئة التشغيل.',
  ALL_CLUSTER_NODES_OCCUPIED: 'كل خوادم WhatsApp الشخصية (5 من 5) مشغولة. تواصل مع الإدارة لزيادة السعة.',
  CUSTOMER_INACTIVE: 'الحساب غير مفعّل.',
  CLAIM_FAILED: 'تعذر حجز خادم WhatsApp لحسابك.',
  ASSIGNED_NODE_NOT_CONFIGURED: 'الخادم المخصص لحسابك غير مضبوط في بيئة التشغيل.',
  NODE_RESET_FAILED: 'تعذر تجهيز خادم WhatsApp. قد يكون في طور التشغيل؛ أعد المحاولة بعد دقيقة.',
  ASSIGNMENT_LOOKUP_FAILED: 'تعذر قراءة حالة الربط.',
  RELEASE_FAILED: 'تعذر فك الربط.',
};
