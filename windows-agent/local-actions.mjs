/**
 * Smart.z Windows Agent – local actions (open documents/links, allowlisted apps and commands)
 *
 * The phone only ever sends a NAME for apps and commands. The path and the
 * arguments come from local-actions.json on this computer, which only the
 * computer's user edits. Copy local-actions.example.json to start.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ACTIONS_FILE = process.env.SMARTZ_AGENT_ACTIONS || join(HERE, 'local-actions.json');

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARACTERS = 900;

export const BLOCKED_OPEN_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.msi', '.msp', '.scr', '.pif', '.lnk', '.hta', '.cpl', '.jar', '.reg', '.application',
  '.appref-ms', '.url', '.scf', '.inf', '.sys', '.dll',
]);

/** Reads the local allowlist; a missing file means nothing is allowed. */
export function loadLocalActions(file = ACTIONS_FILE) {
  if (!existsSync(file)) return { apps: [], commands: [] };
  const parsed = JSON.parse(readFileSync(file, 'utf-8'));
  const clean = (list, withArgs) => (Array.isArray(list) ? list : [])
    .filter((item) => typeof item?.name === 'string' && item.name.trim() && typeof item?.path === 'string' && item.path.trim())
    .map((item) => ({
      name: item.name.trim(),
      path: item.path.trim(),
      ...(withArgs ? { args: Array.isArray(item.args) ? item.args.map(String) : [] } : {}),
    }));
  return { apps: clean(parsed.apps, false), commands: clean(parsed.commands, true) };
}

/** Exact name (ignoring case) first, then a single partial match. */
export function findByName(items, requested) {
  const wanted = String(requested || '').trim().toLowerCase();
  const exact = items.filter((item) => item.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = wanted
    ? items.filter((item) => item.name.toLowerCase().includes(wanted) || wanted.includes(item.name.toLowerCase()))
    : [];
  return partial.length === 1 ? partial[0] : null;
}

/** Opens a file or link with the computer's default handler, without a shell. */
export function defaultLauncher(target) {
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
}

export function openDocument(fullPath, relativePath, launcher = defaultLauncher) {
  if (!existsSync(fullPath)) return { error: 'الملف غير موجود', path: relativePath };
  if (BLOCKED_OPEN_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
    return { error: 'لا يُسمح بفتح البرامج أو السكربتات كملفات', path: relativePath, code: 'BLOCKED_TYPE' };
  }
  launcher(fullPath);
  return { opened: relativePath };
}

export function openUrl(url, launcher = defaultLauncher) {
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'رابط غير صالح' }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { error: 'يُسمح بروابط http وhttps فقط' };
  }
  launcher(parsed.toString());
  return { opened: parsed.hostname };
}

export function openApp(appName, actions = loadLocalActions(), launcher = defaultLauncher) {
  const app = findByName(actions.apps, appName);
  if (!app) return { error: 'البرنامج غير موجود في قائمة هذا الكمبيوتر', code: 'APP_NOT_IN_LOCAL_LIST', available: actions.apps.map((a) => a.name) };
  if (!existsSync(app.path)) return { error: 'ملف البرنامج غير موجود', code: 'FILE_NOT_FOUND', app: app.name };
  const child = spawn(app.path, [], { cwd: dirname(app.path), detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
  return { started: app.name };
}

export function runCommand(commandName, actions = loadLocalActions(), { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const command = findByName(actions.commands, commandName);
  if (!command) {
    return Promise.resolve({ error: 'الأمر غير موجود في قائمة هذا الكمبيوتر', code: 'COMMAND_NOT_IN_LOCAL_LIST', available: actions.commands.map((c) => c.name) });
  }
  if (!existsSync(command.path)) return Promise.resolve({ error: 'ملف الأمر غير موجود', code: 'FILE_NOT_FOUND', command: command.name });

  // Batch files cannot be spawned directly on Windows; they need cmd.exe.
  const isBatch = ['.bat', '.cmd'].includes(extname(command.path).toLowerCase());
  const [file, args] = isBatch
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', command.path, ...command.args]]
    : [command.path, command.args];

  return new Promise((resolvePromise) => {
    let output = '';
    const append = (chunk) => { if (output.length < MAX_OUTPUT_CHARACTERS) output += chunk.toString('utf-8'); };
    const child = spawn(file, args, { cwd: dirname(command.path), shell: false, windowsHide: true });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ error: err.message, code: 'COMMAND_FAILED', command: command.name });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const text = output.trim().slice(0, MAX_OUTPUT_CHARACTERS);
      if (signal) resolvePromise({ error: 'انتهت مهلة الأمر', code: 'COMMAND_TIMED_OUT', command: command.name, output: text });
      else resolvePromise({ command: command.name, exitCode, output: text });
    });
  });
}
