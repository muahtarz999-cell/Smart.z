import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  describeNow,
  locationInstruction,
  networkLocation,
  reverseGeocode,
  sanitizeCoords,
  sanitizeLocation,
  timeInstruction,
} from '../lib/assistant-context.js';
import { cleanSearchAnswer, WEB_SEARCH_TOOL } from '../lib/assistant-response.js';
import { runDriveTurn } from '../lib/drive-turn.js';

// ---------------------------------------------------------------- time

test('time: Gregorian, weekday, 24h time and Hijri (Umm al-Qura) in the user zone', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const riyadh = describeNow(now, 'Asia/Riyadh');
  assert.equal(riyadh.gregorian, '2026-10-22');
  assert.equal(riyadh.time, '15:00');
  assert.equal(riyadh.weekday, 'الخميس');
  assert.match(riyadh.hijri, /1448/);
  assert.equal(describeNow(now, 'America/New_York').time, '08:00');
  assert.equal(describeNow(now, 'Not/AZone').timeZone, 'Asia/Riyadh');
  assert.equal(describeNow(new Date('2026-10-22T22:30:00Z'), 'Asia/Riyadh').gregorian, '2026-10-23', 'after midnight in Riyadh');
  assert.match(timeInstruction(now), /2026-10-22 \(الخميس\)، الساعة 15:00/);
  assert.match(timeInstruction(now), /ولا تقدّر من عندك/);
});

// ---------------------------------------------------------------- location

test('location: names only; GPS stated as sure, network as an estimate', () => {
  assert.equal(sanitizeLocation({}), null);
  assert.equal(sanitizeLocation({ city: '<script>' }).city, 'script', 'no markup reaches the prompt');
  assert.match(locationInstruction({ city: 'جدة', country: 'السعودية', source: 'gps' }), /المستخدم الآن في: جدة، السعودية/);
  assert.match(locationInstruction({ city: 'Riyadh', source: 'network' }), /تقدير/);
  assert.match(locationInstruction(null), /غير معروف/);
  assert.deepEqual(sanitizeCoords({ lat: 21.54321, lon: 39.17299 }), { lat: 21.54, lon: 39.17 });
  assert.equal(sanitizeCoords({ lat: 200, lon: 0 }), null);
  assert.equal(sanitizeCoords(null), null);
});

test('location: Cloudflare headers or cf object give the network estimate', () => {
  const headers = new Map([['cf-ipcity', 'Dammam'], ['cf-ipcountry', 'SA']]);
  assert.deepEqual(networkLocation(headers), { city: 'Dammam', region: '', country: 'السعودية', source: 'network' });
  assert.deepEqual(networkLocation(new Map(), { city: 'Jeddah', region: 'Makkah', country: 'SA' }).city, 'Jeddah');
  assert.equal(networkLocation(new Map([['cf-ipcountry', 'XX']])), null);
});

test('location: GPS → city through OpenStreetMap, cached, null on failure', async () => {
  let calls = 0;
  const fetchOk = async (url) => {
    calls += 1;
    assert.match(String(url), /lat=24\.71&lon=46\.68/);
    return { ok: true, json: async () => ({ address: { city: 'الرياض', state: 'منطقة الرياض', country: 'السعودية' } }) };
  };
  const first = await reverseGeocode({ lat: 24.7136, lon: 46.6753 }, fetchOk);
  assert.deepEqual(first, { city: 'الرياض', region: 'منطقة الرياض', country: 'السعودية', source: 'gps' });
  await reverseGeocode({ lat: 24.7141, lon: 46.6799 }, fetchOk);
  assert.equal(calls, 1, 'same ~1 km cell is cached');
  assert.equal(await reverseGeocode({ lat: 10, lon: 10 }, async () => { throw new Error('down'); }), null);
  assert.equal(await reverseGeocode({ lat: 'x' }, fetchOk), null);
});

// ---------------------------------------------------------------- web search

test('web search: tool definition and cleaned answers', () => {
  assert.equal(WEB_SEARCH_TOOL.function.name, 'web_search');
  assert.deepEqual(WEB_SEARCH_TOOL.function.parameters.required, ['query']);
  assert.equal(cleanSearchAnswer('سعر الذهب اليوم 250 ريال【2†L6-L10】 للغرام.【0†source】'), 'سعر الذهب اليوم 250 ريال للغرام.');
});

test('driving: a recent question goes to the web search, with time and location', async () => {
  const seen = {};
  const result = await runDriveTurn({ audio: {}, context: {} }, {
    transcribe: async () => 'كم سعر الذهب اليوم',
    assistantTurn: async (text, options) => {
      seen.options = options;
      return { reply: '', toolCalls: [{ name: 'web_search', args: { query: 'سعر الذهب اليوم السعودية' } }] };
    },
    sendTool: { name: 'send_whatsapp_message' },
    planSend: null,
    webSearchTool: WEB_SEARCH_TOOL,
    webSearchInstruction: 'ابحث',
    webSearch: async (question, query, options) => {
      seen.search = { question, query, options };
      return 'سعر غرام الذهب عيار 24 اليوم 250 ريال تقريبًا.';
    },
    timeZone: 'Asia/Riyadh',
    location: { city: 'الرياض', source: 'network' },
    synthesize: async () => ({ audio: new Uint8Array([1]), contentType: 'audio/wav' }),
  });
  assert.equal(result.reply, 'سعر غرام الذهب عيار 24 اليوم 250 ريال تقريبًا.');
  assert.deepEqual(seen.options.tools.map((tool) => tool.function?.name), ['web_search']);
  assert.equal(seen.options.timeZone, 'Asia/Riyadh');
  assert.equal(seen.search.query, 'سعر الذهب اليوم السعودية');
  assert.equal(seen.search.options.location.city, 'الرياض');
  assert.equal(seen.search.options.channel, 'driving');
});

test('wiring: every owner conversation gets time and location; web search on the main screen', async () => {
  const response = await readFile(new URL('../lib/assistant-response.js', import.meta.url), 'utf8');
  assert.match(response, /withOwner \? timeInstruction\(options\.now \|\| new Date\(\), options\.timeZone\) : ''/);
  assert.match(response, /tools: \[\{ type: 'browser_search' \}\]/);
  assert.match(response, /`\$\{attempt\.model\}:online`/);
  const route = await readFile(new URL('../app/api/assistant/route.js', import.meta.url), 'utf8');
  assert.match(route, /const tools = \[WEB_SEARCH_TOOL\]/);
  assert.match(route, /resolveUserLocation\(request, capabilities\.coords\)/);
  assert.match(route, /answerWithWebSearch\(message, query, conversation\)/);
  const knowledge = await readFile(new URL('../lib/assistant-self-knowledge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(knowledge, /لا تتصفح الإنترنت/);
  assert.match(knowledge, /web_search/);
});
