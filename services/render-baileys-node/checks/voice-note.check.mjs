import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ffmpegPath from 'ffmpeg-static';
import { toVoiceNote } from '../voice-note.js';

async function tone(args) {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'vn-test-')), 'tone');
  const result = spawnSync(ffmpegPath, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1', ...args, file]);
  assert.equal(result.status, 0, String(result.stderr));
  return fs.readFile(file);
}

function describe(ogg) {
  const file = path.join(os.tmpdir(), `vn-out-${process.pid}.ogg`);
  return fs.writeFile(file, ogg).then(() => String(spawnSync(ffmpegPath, ['-hide_banner', '-i', file]).stderr));
}

test('wav and mp3 chunks (even mixed) become one OGG Opus voice note, mono 48 kHz', async () => {
  const wav = await tone(['-ar', '24000', '-ac', '1', '-f', 'wav']);
  const mp3 = await tone(['-ar', '22050', '-ac', '2', '-f', 'mp3']);
  const ogg = await toVoiceNote([wav, mp3, wav]);
  assert.equal(ogg.subarray(0, 4).toString(), 'OggS');
  const info = await describe(ogg);
  assert.match(info, /Audio: opus, 48000 Hz, mono/);
  assert.match(info, /Duration: 00:00:03/);
});

test('audio ffmpeg cannot read fails loudly instead of producing a broken note', async () => {
  await assert.rejects(toVoiceNote([Buffer.alloc(4000, 7)]), /ffmpeg exited/);
  await assert.rejects(toVoiceNote([]), /NO_AUDIO/);
});
