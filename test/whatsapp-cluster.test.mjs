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
      if (name === 'release_whatsapp_cluster_node') return { data: release, error: null };
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
    if (href.endsWith('/api/reset')) return { ok: resetOk, status: resetOk ? 200 : 500, json: async () => ({}) };
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
  const reset = requests.find((r) => r.href.endsWith('/api/reset'));
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
  assert.ok(client.calls.some((c) => c.name === 'release_whatsapp_cluster_node'));
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
  assert.ok(requests.some((r) => r.href === 'https://node2.example/api/reset'));
});
