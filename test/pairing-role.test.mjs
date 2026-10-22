import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { detectPairingRole } from '../lib/pairing-role.js';

const nav = (userAgent, extra = {}) => ({ navigator: { userAgent, ...extra } });

test('pairing role: Capacitor Android/iOS app is the phone', () => {
  assert.equal(detectPairingRole({ Capacitor: { getPlatform: () => 'android' }, navigator: {} }), 'phone');
  assert.equal(detectPairingRole({ Capacitor: { getPlatform: () => 'ios' }, navigator: {} }), 'phone');
});

test('pairing role: desktop browsers are the computer', () => {
  assert.equal(detectPairingRole(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')), 'computer');
  assert.equal(detectPairingRole(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1', { maxTouchPoints: 0 })), 'computer');
  assert.equal(detectPairingRole(undefined), 'computer');
});

test('pairing role: mobile browsers are the phone', () => {
  assert.equal(detectPairingRole(nav('Mozilla/5.0 (Linux; Android 14; SM-S918B) Mobile Safari/537.36')), 'phone');
  assert.equal(detectPairingRole(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')), 'phone');
  assert.equal(detectPairingRole(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', { maxTouchPoints: 5 })), 'phone');
});

test('pairing role: client hints take precedence over the UA string', () => {
  assert.equal(detectPairingRole(nav('Android Mobile', { userAgentData: { mobile: false } })), 'computer');
  assert.equal(detectPairingRole(nav('Windows NT 10.0', { userAgentData: { mobile: true } })), 'phone');
});

test('main menu offers both pairing sides (show QR on computer, scan on phone)', async () => {
  const chooser = await readFile(new URL('../components/ComputerPairingChooser.jsx', import.meta.url), 'utf8');
  assert.match(chooser, /href="\/computer\/pair"/);
  assert.match(chooser, /href="\/computer\/approve"/);
  const page = await readFile(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(page, /<ComputerPairingChooser \/>/);
});
