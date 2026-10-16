/**
 * Turns one or more audio chunks (wav/mp3 from the cloud voices) into a
 * single WhatsApp voice note: OGG container, Opus codec, mono, 48 kHz.
 * WhatsApp shows anything else as a file attachment instead of a voice note.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

export async function toVoiceNote(chunks) {
  if (!chunks.length) throw new Error('NO_AUDIO');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartz-voice-'));
  try {
    const inputs = [];
    for (const [index, chunk] of chunks.entries()) {
      const file = path.join(dir, `part-${index}`);
      await fs.writeFile(file, chunk);
      inputs.push('-i', file);
    }
    const output = path.join(dir, 'voice.ogg');
    const filter = `${chunks.map((_, i) => `[${i}:a]`).join('')}concat=n=${chunks.length}:v=0:a=1[out]`;
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', ...inputs,
      '-filter_complex', filter, '-map', '[out]',
      '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
      output,
    ]);
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 300)}`))));
  });
}
