import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await readFile(new URL('../lib/whatsapp-cluster.js', import.meta.url), 'utf8'))
  .replace("import { createClient } from '@supabase/supabase-js';", 'const createClient = () => null;');
const cluster = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function configureNodes(count) {
  for (let id = 1; id <= 5; id += 1) {
    delete process.env[`RENDER_SERVER_${id}_URL`];
    delete process.env[`RENDER_SERVER_${id}_KEY`];
  }
  for (let id = 1; id <= count; id += 1) {
    process.env[`RENDER_SERVER_${id}_URL`] = `https://node${id}.example/`;
    process.env[`RENDER_SERVER_${id}_KEY`] = `key-${id}-xxxxxxxxxxxxxxxxxxxxxxxx`;
  }
}

function fakeClient({ assignment = null, claim, release = null } = {}) {
  const calls = [];
  return {
    calls,
    from() {
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: assignment, error: null }) };
      return query;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_whatsapp_cluster_node') return { data: claim, error: null };
      // Since slots (2026-10-22) the release says which (node, slot) was freed.
      if (name === 'release_whatsapp_cluster_slot') return { data: { node_id: release, slot: release ? 0 : null }, error: null };
      return { data: null, error: null };
    },
  };
}

function fakeFetch({ awake = [], resetOk = true } = {}) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    requests.push({ href, init });
    const id = Number(href.match(/node(\d)/)?.[1]);
    if (href.endsWith('/healthz')) {
      if (!awake.includes(id)) throw new Error('sleeping');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (new URL(href).pathname === '/api/reset') return { ok: resetOk, status: resetOk ? 200 : 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return requests;
}

test('only nodes with both URL and key are used; trailing slashes are trimmed', () => {
  configureNodes(2);
  process.env.RENDER_SERVER_3_URL = 'https://node3.example';
  const nodes = cluster.getConfiguredClusterNodes();
  assert.deepEqual(nodes.map((n) => n.id), [1, 2]);
  assert.equal(nodes[0].url, 'https://node1.example');
});

test('a new claim offers awake nodes first and wipes the node before handing it over', async () => {
  configureNodes(3);
  const requests = fakeFetch({ awake: [3] });
  const client = fakeClient({ claim: { success: true, node_id: 3, is_new: true } });
  const { node, isNew } = await cluster.allocateNode(client, 'user-1');
  assert.equal(node.id, 3);
  assert.equal(isNew, true);
  assert.deepEqual(client.calls[0].args.p_candidates.map((c) => c.id), [3, 1, 2]);
  const reset = requests.find((r) => new URL(r.href).pathname === '/api/reset');
  assert.ok(reset, 'node must be reset');
  assert.equal(reset.init.headers.Authorization, 'Bearer key-3-xxxxxxxxxxxxxxxxxxxxxxxx');
});

test('an existing assignment skips health checks and reset', async () => {
  configureNodes(3);
  const requests = fakeFetch();
  const client = fakeClient({ assignment: { node_id: 2, status: 'connected' } });
  const { node, isNew } = await cluster.allocateNode(client, 'user-1');
  assert.equal(node.id, 2);
  assert.equal(isNew, false);
  assert.equal(requests.length, 0);
  assert.equal(client.calls.length, 0);
});

test('if the reset fails the reservation is released, never handed over', async () => {
  configureNodes(1);
  fakeFetch({ awake: [1], resetOk: false });
  const client = fakeClient({ claim: { success: true, node_id: 1, is_new: true } });
  await assert.rejects(cluster.allocateNode(client, 'user-1'), (error) => error.code === 'NODE_RESET_FAILED');
  assert.ok(client.calls.some((c) => c.name === 'release_whatsapp_cluster_slot'));
});

test('a full cluster is reported as such; there is no fallback node', async () => {
  configureNodes(5);
  fakeFetch();
  const client = fakeClient({ claim: { success: false, error: 'ALL_CLUSTER_NODES_OCCUPIED' } });
  await assert.rejects(cluster.allocateNode(client, 'user-1'), (error) => error.code === 'ALL_CLUSTER_NODES_OCCUPIED');
});

test('release wipes the session on the node that was freed', async () => {
  configureNodes(2);
  const requests = fakeFetch();
  const client = fakeClient({ release: 2 });
  assert.deepEqual(await cluster.releaseNode(client), { released: true, nodeId: 2 });
  assert.ok(requests.some((r) => r.href === 'https://node2.example/api/reset?slot=0'));
});

// ---------------------------------------------------------------- several customers per node (2026-10-22)

test('slots: one customer per node by default; RENDER_SERVER_<N>_SLOTS raises it (max 20)', () => {
  const env = {
    RENDER_SERVER_1_URL: 'https://node1.example', RENDER_SERVER_1_KEY: 'k1',
    RENDER_SERVER_2_URL: 'https://node2.example', RENDER_SERVER_2_KEY: 'k2', RENDER_SERVER_2_SLOTS: '8',
    RENDER_SERVER_3_URL: 'https://node3.example', RENDER_SERVER_3_KEY: 'k3', RENDER_SERVER_3_SLOTS: '99',
  };
  assert.deepEqual(cluster.getConfiguredClusterNodes(env).map((node) => node.slots), [1, 8, 20]);
  assert.equal(cluster.clusterCapacity(env), 29);
  assert.equal(cluster.slotsFor(4, { RENDER_SERVER_4_SLOTS: 'abc' }), 1);
});

test('slots: the claim offers each node with its slot count; the slot reaches every node call', async () => {
  configureNodes(2);
  process.env.RENDER_SERVER_2_SLOTS = '6';
  const requests = fakeFetch({ awake: [1, 2] });
  const client = fakeClient({ claim: { success: true, node_id: 2, slot: 4, is_new: true } });
  const { node } = await cluster.allocateNode(client, 'user-1');
  delete process.env.RENDER_SERVER_2_SLOTS;
  const claim = client.calls.find((c) => c.name === 'claim_whatsapp_cluster_node');
  assert.deepEqual(claim.args.p_candidates.map((c) => c.slots), [1, 6]);
  assert.equal(node.id, 2);
  assert.equal(node.slot, 4);
  assert.ok(requests.some((r) => r.href === 'https://node2.example/api/reset?slot=4'), 'only slot 4 is wiped');
});

test('slots: assignments without a slot column (before the migration) are slot 0', () => {
  configureNodes(1);
  assert.equal(cluster.nodeForAssignment({ node_id: 1 }).slot, 0);
  assert.equal(cluster.nodeForAssignment({ node_id: 1, slot: 3 }).slot, 3);
  assert.equal(cluster.nodeForAssignment(null), null);
  assert.equal(cluster.slotFromBody({}), 0);
  assert.equal(cluster.slotFromBody({ slot: 5 }), 5);
  assert.equal(cluster.slotFromBody({ slot: 'x' }), -1);
  assert.equal(cluster.slotFromBody({ slot: 50 }), -1);
});

test('slots: node service keeps one session per slot and slot 0 on the old keys', async () => {
  const { slotPrefix } = await import('../services/render-baileys-node/slots.js');
  assert.equal(slotPrefix(0), '');
  assert.equal(slotPrefix(undefined), '');
  assert.equal(slotPrefix(3), 'slot3/');
  const node = await readFile(new URL('../services/render-baileys-node/index.js', import.meta.url), 'utf8');
  assert.match(node, /function createSession\(slot\)/);
  assert.match(node, /app\.post\('\/api\/send', withSession\(/);
  assert.match(node, /app\.post\('\/api\/reset', withSession\(/);
  assert.match(node, /nodeId: NODE_ID,\s+slot,\s+remoteJid/);
  assert.match(node, /JSON\.stringify\(\{ nodeId: NODE_ID, slot \}\)/);
  const auth = await readFile(new URL('../services/render-baileys-node/supabase-auth-state.js', import.meta.url), 'utf8');
  assert.match(auth, /query\.not\('key', 'like', 'slot%\/%'\)/, 'clearing slot 0 must keep the other slots');
  const migration = await readFile(new URL('../supabase/migrations/202610220004_whatsapp_multi_slot.sql', import.meta.url), 'utf8');
  assert.match(migration, /drop index if exists public\.whatsapp_tenant_nodes_node_id_key/);
  assert.match(migration, /on public\.whatsapp_tenant_nodes \(node_id, slot\)/);
  assert.match(migration, /create or replace function public\.release_whatsapp_cluster_slot\(\)/);
  for (const route of ['message', 'call']) {
    const source = await readFile(new URL(`../app/api/whatsapp/cluster/${route}/route.js`, import.meta.url), 'utf8');
    assert.match(source, /\.eq\('slot', slotFromBody\(body\)\)/, route);
  }
});
