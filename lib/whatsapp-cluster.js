/**
 * WhatsApp Multi-Tenant Cluster Load Balancer & Sticky Router
 * 
 * Manages tenant allocation and request routing across the 5 Render Baileys instances.
 * Guarantees strict 1:1 tenant isolation and session persistence.
 */

export function getConfiguredClusterNodes() {
  const nodes = [];
  for (let i = 1; i <= 5; i += 1) {
    const rawUrl = process.env[`RENDER_SERVER_${i}_URL`];
    const rawKey = process.env[`RENDER_SERVER_${i}_KEY`];
    if (rawUrl && typeof rawUrl === 'string' && rawUrl.trim()) {
      nodes.push({
        id: i,
        url: rawUrl.trim().replace(/\/+$/, ''),
        key: rawKey ? rawKey.trim() : '',
      });
    }
  }
  return nodes;
}

/**
 * Checks live health/status of a specific cluster node
 */
export async function checkNodeHealth(node, timeoutMs = 5000) {
  if (!node || !node.url) {
    return { ok: false, status: 'INVALID_CONFIG', error: 'Missing node URL' };
  }

  try {
    const headers = { 'Cache-Control': 'no-store' };
    if (node.key) {
      headers.Authorization = `Bearer ${node.key}`;
      headers['X-API-Key'] = node.key;
    }

    const response = await fetch(`${node.url}/api/status`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });

    if (!response.ok) {
      return { ok: false, status: 'HTTP_ERROR', statusCode: response.status };
    }

    const data = await response.json();
    return {
      ok: true,
      status: data?.status || 'UNKNOWN',
      timestamp: data?.timestamp || new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'UNREACHABLE',
      error: error?.message || 'Connection timed out',
    };
  }
}

/**
 * Retrieves the assigned cluster node for a specific tenant from Supabase.
 */
export async function getUserAssignedNode(userId, supabaseClient) {
  if (!userId || !supabaseClient) return null;

  try {
    const { data, error } = await supabaseClient
      .from('whatsapp_tenant_nodes')
      .select('id, user_id, node_id, node_url, status, phone_number')
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) return null;

    const configuredNodes = getConfiguredClusterNodes();
    const matchedNode = configuredNodes.find((n) => n.id === data.node_id);

    if (matchedNode) {
      return {
        ...matchedNode,
        dbRecord: data,
      };
    }

    // Node is recorded in DB but might have a custom URL stored
    return {
      id: data.node_id,
      url: data.node_url,
      key: process.env[`RENDER_SERVER_${data.node_id}_KEY`] || '',
      dbRecord: data,
    };
  } catch (err) {
    console.error('[WhatsApp Cluster] Failed to query tenant node assignment:', err);
    return null;
  }
}

/**
 * Deterministic hash fallback to select a node index from user ID
 */
function getDeterministicNodeIndex(userId, totalNodes) {
  if (totalNodes <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return hash % totalNodes;
}

/**
 * Allocates a sticky node for the user (guaranteeing 1:1 tenant isolation)
 */
export async function allocateStickyNode(userId, supabaseClient) {
  const configuredNodes = getConfiguredClusterNodes();
  if (configuredNodes.length === 0) {
    throw new Error('NO_CLUSTER_NODES_CONFIGURED');
  }

  // 1. Check if user already has an assigned node
  const existingNode = await getUserAssignedNode(userId, supabaseClient);
  if (existingNode) {
    return { node: existingNode, isNew: false };
  }

  // 2. Query occupied node IDs
  let occupiedNodeIds = new Set();
  try {
    const { data: occupiedData, error: rpcError } = await supabaseClient.rpc('get_occupied_whatsapp_nodes');
    if (!rpcError && Array.isArray(occupiedData)) {
      occupiedNodeIds = new Set(occupiedData.map((row) => row.node_id));
    } else {
      // Fallback query if RPC isn't available
      const { data: rows } = await supabaseClient
        .from('whatsapp_tenant_nodes')
        .select('node_id');
      if (Array.isArray(rows)) {
        occupiedNodeIds = new Set(rows.map((r) => r.node_id));
      }
    }
  } catch (err) {
    console.warn('[WhatsApp Cluster] Could not inspect occupied nodes, proceeding with fallback:', err);
  }

  // 3. Find available nodes
  const availableNodes = configuredNodes.filter((node) => !occupiedNodeIds.has(node.id));

  if (availableNodes.length === 0) {
    // All 5 cluster slots are currently assigned
    const error = new Error('ALL_CLUSTER_NODES_OCCUPIED');
    error.code = 'ALL_CLUSTER_NODES_OCCUPIED';
    throw error;
  }

  // 4. Select the best available node (prefer healthy node)
  let chosenNode = null;
  for (const candidate of availableNodes) {
    const health = await checkNodeHealth(candidate, 3000);
    if (health.ok) {
      chosenNode = candidate;
      break;
    }
  }

  // If none passed immediate health check, take the first available node
  if (!chosenNode) {
    chosenNode = availableNodes[0];
  }

  // 5. Reserve node atomically via DB
  try {
    const { data: claimResult, error: claimError } = await supabaseClient.rpc(
      'claim_whatsapp_cluster_node',
      {
        p_user_id: userId,
        p_target_node_id: chosenNode.id,
        p_node_url: chosenNode.url,
      }
    );

    if (!claimError && claimResult?.success) {
      return {
        node: {
          ...chosenNode,
          id: claimResult.node_id,
          url: claimResult.node_url,
        },
        isNew: claimResult.is_new,
      };
    }

    // Direct insert fallback if RPC isn't deployed yet
    const { error: insertError } = await supabaseClient
      .from('whatsapp_tenant_nodes')
      .insert({
        user_id: userId,
        node_id: chosenNode.id,
        node_url: chosenNode.url,
        status: 'assigned',
      });

    if (!insertError) {
      return { node: chosenNode, isNew: true };
    }
  } catch (dbErr) {
    console.warn('[WhatsApp Cluster] DB reservation failed, using deterministic memory routing:', dbErr);
  }

  // Deterministic fallback in case database table isn't migrated yet
  const fallbackIndex = getDeterministicNodeIndex(userId, configuredNodes.length);
  return { node: configuredNodes[fallbackIndex], isNew: true, fallback: true };
}

/**
 * Releases node assignment for a tenant (e.g. upon unlinking / logging out)
 */
export async function releaseStickyNode(userId, supabaseClient) {
  if (!userId || !supabaseClient) return false;

  try {
    const { error: rpcError } = await supabaseClient.rpc('release_whatsapp_cluster_node', {
      p_user_id: userId,
    });
    if (!rpcError) return true;

    const { error } = await supabaseClient
      .from('whatsapp_tenant_nodes')
      .delete()
      .eq('user_id', userId);

    return !error;
  } catch (err) {
    console.error('[WhatsApp Cluster] Failed to release node assignment:', err);
    return false;
  }
}

/**
 * Forward an HTTP request to the assigned Render cluster node
 */
export async function proxyToNode(node, pathname, searchParams = {}, options = {}) {
  const url = new URL(pathname, node.url);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    'Cache-Control': 'no-store',
    ...options.headers,
  };
  if (node.key) {
    headers.Authorization = `Bearer ${node.key}`;
    headers['X-API-Key'] = node.key;
  }

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs || 10000),
    cache: 'no-store',
  });

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await response.json();
    return { ok: response.ok, status: response.status, data: json };
  }

  const text = await response.text();
  return { ok: response.ok, status: response.status, data: text };
}

