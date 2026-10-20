/**
 * Smart.z Windows Agent – task executor
 *
 * Executes ONLY the four allowlisted file task types.
 * All paths are validated against authorizedRoot before any operation.
 * No shell commands. No arbitrary file access outside authorizedRoot.
 */

import { readdir, stat, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, normalize, dirname, sep } from 'node:path';

// ─── Path sandboxing ──────────────────────────────────────────────────────────

function sandboxed(authorizedRoot, ...parts) {
  const root = normalize(resolve(authorizedRoot));
  // Tasks originate from Windows clients, but the agent's tests and CI may run
  // on Linux. Treat both slash styles as path separators before resolving.
  const portableParts = parts.map((part) => String(part).replace(/[\\/]+/g, sep));
  const full = normalize(resolve(root, ...portableParts));
  if (!full.startsWith(root + sep) && full !== root) {
    throw Object.assign(new Error('مسار خارج نطاق الصلاحية'), { code: 'OUTSIDE_SANDBOX' });
  }
  return full;
}

// ─── list_files ───────────────────────────────────────────────────────────────

export async function listFiles(payload) {
  const root = payload.authorizedRoot;
  const subPath = payload.path ?? '';
  const maxEntries = payload.maxEntries ?? 200;
  const targetDir = subPath ? sandboxed(root, subPath) : normalize(resolve(root));

  if (!existsSync(targetDir)) return { error: 'المسار غير موجود', path: subPath || '.' };
  const statDir = await stat(targetDir);
  if (!statDir.isDirectory()) return { error: 'المسار ليس مجلدًا', path: subPath || '.' };

  const entries = await readdir(targetDir, { withFileTypes: true });
  const results = [];
  for (const entry of entries.slice(0, maxEntries)) {
    try {
      const info = await stat(join(targetDir, entry.name));
      results.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isFile() ? info.size : undefined,
        modified: info.mtime.toISOString(),
      });
    } catch {
      results.push({ name: entry.name, type: 'unknown' });
    }
  }
  return { path: subPath || '.', count: results.length, truncated: entries.length > maxEntries, entries: results };
}

// ─── search_files ─────────────────────────────────────────────────────────────

export async function searchFiles(payload) {
  const root = payload.authorizedRoot;
  const subPath = payload.path ?? '';
  const query = payload.query.toLowerCase();
  const maxResults = payload.maxResults ?? 50;
  const startDir = subPath ? sandboxed(root, subPath) : normalize(resolve(root));

  if (!existsSync(startDir)) return { error: 'مسار البحث غير موجود' };

  const results = [];
  const rootNorm = normalize(resolve(root));

  async function walk(dir, depth) {
    if (results.length >= maxResults || depth > 6) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.toLowerCase().includes(query)) {
        const fullPath = join(dir, entry.name);
        const rel = fullPath.slice(rootNorm.length + 1);
        try {
          const info = await stat(fullPath);
          results.push({
            name: entry.name, path: rel,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isFile() ? info.size : undefined,
            modified: info.mtime.toISOString(),
          });
        } catch {
          results.push({ name: entry.name, path: rel, type: 'unknown' });
        }
      }
      if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(startDir, 0);
  return { query: payload.query, count: results.length, truncated: results.length >= maxResults, results };
}

// ─── file_metadata ────────────────────────────────────────────────────────────

export async function fileMetadata(payload) {
  const fullPath = sandboxed(payload.authorizedRoot, payload.path);
  if (!existsSync(fullPath)) return { error: 'الملف أو المجلد غير موجود', path: payload.path };
  const info = await stat(fullPath);
  return {
    path: payload.path,
    type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
    size: info.isFile() ? info.size : undefined,
    created: info.birthtime.toISOString(),
    modified: info.mtime.toISOString(),
    accessed: info.atime.toISOString(),
  };
}

// ─── transfer_file ────────────────────────────────────────────────────────────

export async function transferFile(payload) {
  const src = sandboxed(payload.authorizedRoot, payload.sourcePath);
  const dst = sandboxed(payload.authorizedRoot, payload.destinationPath);
  if (!existsSync(src)) return { error: 'الملف المصدر غير موجود', sourcePath: payload.sourcePath };
  const srcStat = await stat(src);
  if (!srcStat.isFile()) return { error: 'المصدر ليس ملفًا', sourcePath: payload.sourcePath };
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  const dstStat = await stat(dst);
  return { success: true, sourcePath: payload.sourcePath, destinationPath: payload.destinationPath, size: dstStat.size };
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

export async function executeTask(task) {
  try {
    let result;
    switch (task.task_type) {
      case 'list_files':    result = await listFiles(task.payload); break;
      case 'search_files':  result = await searchFiles(task.payload); break;
      case 'file_metadata': result = await fileMetadata(task.payload); break;
      case 'transfer_file': result = await transferFile(task.payload); break;
      default:
        return { status: 'failed', result: { error: 'نوع مهمة غير مدعوم', task_type: task.task_type } };
    }
    if (result.error) return { status: 'failed', result };
    return { status: 'succeeded', result };
  } catch (err) {
    return { status: 'failed', result: { error: err.message ?? 'خطأ غير متوقع', code: err.code ?? 'EXEC_ERROR' } };
  }
}
