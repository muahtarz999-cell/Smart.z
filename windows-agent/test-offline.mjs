/**
 * Smart.z Windows Agent – offline unit tests
 * Usage: node test-offline.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import test from 'node:test';

import { generateKeyPair, signPairingProof, signRequest, makeNonce } from './crypto.mjs';
import { listFiles, searchFiles, fileMetadata, transferFile, executeTask } from './tasks.mjs';

function verifyPairingProof(pubB64, sessionId, challenge, sig) {
  const key = createPublicKey({ key: Buffer.from(pubB64, 'base64url'), format: 'der', type: 'spki' });
  const msg = Buffer.from(`smartz-computer-pairing:v1:${sessionId}:${challenge}`, 'utf8');
  return verify(null, msg, key, Buffer.from(sig, 'base64url'));
}

// ── file task fixtures ───────────────────────────────────────────────────────

let tmpRoot;
test.before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'smartz-agent-test-'));
  await mkdir(join(tmpRoot, 'docs'));
  await mkdir(join(tmpRoot, 'images'));
  await mkdir(join(tmpRoot, 'empty'));
  await writeFile(join(tmpRoot, 'docs', 'report.txt'), 'Hello Smart.z');
  await writeFile(join(tmpRoot, 'images', 'photo.jpg'), Buffer.alloc(1024, 0));
  await writeFile(join(tmpRoot, 'readme.md'), '# Test');
});
test.after(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

// ── list_files ───────────────────────────────────────────────────────────────

test('listFiles: root contains docs dir + readme.md file', async () => {
  const r = await listFiles({ authorizedRoot: tmpRoot });
  assert.ok(!r.error);
  assert.ok(r.entries.some((e) => e.name === 'docs' && e.type === 'directory'));
  assert.ok(r.entries.some((e) => e.name === 'readme.md' && e.type === 'file'));
});

test('listFiles: sub-path docs → report.txt only', async () => {
  const r = await listFiles({ authorizedRoot: tmpRoot, path: 'docs' });
  assert.ok(!r.error);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].name, 'report.txt');
});

test('listFiles: maxEntries truncates', async () => {
  const r = await listFiles({ authorizedRoot: tmpRoot, maxEntries: 1 });
  assert.equal(r.count, 1);
  assert.equal(r.truncated, true);
});

// ── search_files ─────────────────────────────────────────────────────────────

test('searchFiles: "report" finds report.txt', async () => {
  const r = await searchFiles({ authorizedRoot: tmpRoot, query: 'report' });
  assert.ok(r.results.some((e) => e.name === 'report.txt'));
});

test('searchFiles: unknown query → empty results', async () => {
  const r = await searchFiles({ authorizedRoot: tmpRoot, query: 'zzznomatch99' });
  assert.equal(r.count, 0);
});

// ── file_metadata ─────────────────────────────────────────────────────────────

test('fileMetadata: file type + size', async () => {
  const r = await fileMetadata({ authorizedRoot: tmpRoot, path: 'readme.md' });
  assert.equal(r.type, 'file');
  assert.equal(r.size, 6);
});

test('fileMetadata: directory type', async () => {
  const r = await fileMetadata({ authorizedRoot: tmpRoot, path: 'docs' });
  assert.equal(r.type, 'directory');
});

test('fileMetadata: missing → error object', async () => {
  const r = await fileMetadata({ authorizedRoot: tmpRoot, path: 'nope.txt' });
  assert.ok(r.error);
});

// ── transfer_file ─────────────────────────────────────────────────────────────

test('transferFile: copies within sandbox', async () => {
  const r = await transferFile({
    authorizedRoot: tmpRoot,
    sourcePath: 'docs\\report.txt',
    destinationPath: 'docs\\report-copy.txt',
  });
  assert.equal(r.success, true);
  const m = await fileMetadata({ authorizedRoot: tmpRoot, path: 'docs\\report-copy.txt' });
  assert.equal(m.type, 'file');
});

// ── sandbox enforcement ───────────────────────────────────────────────────────

test('sandbox: listFiles traversal blocked', async () => {
  const r = await executeTask({ task_type: 'list_files', payload: { authorizedRoot: tmpRoot, path: '..\\..\\Windows' } });
  assert.equal(r.status, 'failed');
});

test('sandbox: fileMetadata traversal blocked', async () => {
  const r = await executeTask({ task_type: 'file_metadata', payload: { authorizedRoot: tmpRoot, path: '..\\..\\Windows\\System32\\cmd.exe' } });
  assert.equal(r.status, 'failed');
});

test('sandbox: transferFile source traversal blocked', async () => {
  const r = await executeTask({ task_type: 'transfer_file', payload: { authorizedRoot: tmpRoot, sourcePath: '..\\..\\Windows\\win.ini', destinationPath: 'stolen.ini' } });
  assert.equal(r.status, 'failed');
});

// ── dispatcher ────────────────────────────────────────────────────────────────

test('executeTask: unknown type → failed + error message', async () => {
  const r = await executeTask({ task_type: 'run_shell', payload: { authorizedRoot: tmpRoot } });
  assert.equal(r.status, 'failed');
  assert.ok(r.result.error.includes('غير مدعوم'));
});

test('executeTask: list_files happy path', async () => {
  const r = await executeTask({ task_type: 'list_files', payload: { authorizedRoot: tmpRoot } });
  assert.equal(r.status, 'succeeded');
  assert.ok(Array.isArray(r.result.entries));
});
test('generateKeyPair: valid Ed25519 SPKI', () => {
  const { privateKeyBase64url, publicKeyBase64url } = generateKeyPair();
  assert.ok(privateKeyBase64url.length > 40);
  const pub = createPublicKey({ key: Buffer.from(publicKeyBase64url, 'base64url'), format: 'der', type: 'spki' });
  assert.equal(pub.asymmetricKeyType, 'ed25519');
});

test('signPairingProof: verifiable 86-char sig', () => {
  const { privateKeyBase64url, publicKeyBase64url } = generateKeyPair();
  const challengeStr = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const sig = signPairingProof(privateKeyBase64url, '11111111-2222-3333-4444-555555555555', challengeStr);
  assert.match(sig, /^[A-Za-z0-9_-]{86}$/);
  assert.ok(verifyPairingProof(publicKeyBase64url, '11111111-2222-3333-4444-555555555555', challengeStr, sig));
});

test('signRequest: correct header shapes', () => {
  const { privateKeyBase64url } = generateKeyPair();
  const h = signRequest({ privateKeyBase64url, method: 'POST',
    pathname: '/api/computer/devices/11111111-0000-0000-0000-000000000000/tasks/claim',
    body: Buffer.from('{}') });
  assert.match(h['x-smartz-timestamp'], /^\d{10}$/);
  assert.ok(h['x-smartz-nonce'].length >= 30);
  assert.match(h['x-smartz-signature'], /^[A-Za-z0-9_-]{86}$/);
});

test('makeNonce: unique url-safe strings', () => {
  const [n1, n2] = [makeNonce(), makeNonce()];
  assert.ok(/^[A-Za-z0-9_-]+$/.test(n1));
  assert.notEqual(n1, n2);
});
