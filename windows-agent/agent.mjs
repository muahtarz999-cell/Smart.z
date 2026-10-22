/**
 * Smart.z Windows Agent – main agent loop
 *
 * Usage:
 *   node agent.mjs [--poll <seconds>]
 *
 * Continuously polls Smart.z for approved tasks, executes them locally,
 * and reports results back. Stops on SIGINT/SIGTERM.
 *
 * File operations run only within authorizedRoot. Apps and commands run only
 * when listed by name in local-actions.json on this computer.
 */

import { loadIdentity } from './identity.mjs';
import { signRequest } from './crypto.mjs';
import { executeTask } from './tasks.mjs';

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return (i !== -1 && i + 1 < args.length) ? args[i + 1] : null;
}
const POLL_SECONDS = Math.max(3, parseInt(argValue('--poll') ?? '5', 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Signed fetch ─────────────────────────────────────────────────────────────

/**
 * Make a signed API request to a /api/computer/devices/ endpoint.
 */
async function signedFetch(identity, method, pathname, bodyObj = null) {
  const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf-8') : Buffer.alloc(0);
  const headers = {
    ...signRequest({ privateKeyBase64url: identity.privateKeyBase64url, method, pathname, body }),
    'Cache-Control': 'no-store',
  };
  if (bodyObj) headers['Content-Type'] = 'application/json';

  const url = `${identity.baseUrl}${pathname}`;
  const res = await fetch(url, { method, headers, body: bodyObj ? body : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

let running = true;
let activeTaskId = null;

process.on('SIGINT', () => {
  console.log('\n⏹  إيقاف الوكيل (SIGINT) ...');
  running = false;
});
process.on('SIGTERM', () => {
  console.log('\n⏹  إيقاف الوكيل (SIGTERM) ...');
  running = false;
});

async function claimTask(identity) {
  const pathname = `/api/computer/devices/${identity.deviceId}/tasks/claim`;
  const { status, json } = await signedFetch(identity, 'POST', pathname);
  if (status === 403 && json.code === 'DEVICE_NOT_ACTIVE') {
    console.error('❌ الجهاز غير نشط أو تم إلغاء ربطه من الهاتف.');
    running = false;
    return null;
  }
  if (status !== 200) {
    console.warn(`⚠️  استعلام المهمة أعاد ${status}:`, json.code ?? '');
    return null;
  }
  return json.task ?? null;
}

async function reportResult(identity, taskId, status, result) {
  const pathname = `/api/computer/devices/${identity.deviceId}/tasks/${taskId}/result`;
  const { status: httpStatus, json } = await signedFetch(identity, 'POST', pathname, { status, result });
  if (httpStatus !== 200) {
    console.warn(`⚠️  فشل إرسال نتيجة المهمة ${taskId}: ${httpStatus}`, json.code ?? '');
  }
}

async function main() {
  let identity;
  try {
    identity = await loadIdentity();
  } catch (err) {
    console.error('❌ لم يتم ربط الجهاز بعد. شغّل أولاً: node keygen.mjs ثم node pair.mjs');
    console.error('  ', err.message);
    process.exit(1);
  }

  console.log('🤖 Smart.z Windows Agent يعمل');
  console.log(`   Device ID : ${identity.deviceId}`);
  console.log(`   Server    : ${identity.baseUrl}`);
  console.log(`   Poll      : كل ${POLL_SECONDS}s`);
  console.log('   اضغط Ctrl+C للإيقاف');
  console.log('');

  let consecutiveErrors = 0;

  while (running) {
    try {
      const task = await claimTask(identity);

      if (task) {
        activeTaskId = task.id;
        console.log(`\n📋 مهمة جديدة [${task.task_type}] id=${task.id}`);
        console.log(`   authorizedRoot: ${task.payload?.authorizedRoot ?? '—'}`);

        const { status, result } = await executeTask(task);

        console.log(`   النتيجة: ${status}`, status === 'succeeded' ? '✅' : '❌');
        if (status === 'failed') console.log(`   الخطأ: ${result.error ?? JSON.stringify(result)}`);

        await reportResult(identity, task.id, status, result);
        activeTaskId = null;
        consecutiveErrors = 0;
      } else {
        // No task or error – dot to show heartbeat every 5 polls
        if (consecutiveErrors === 0) process.stdout.write('·');
      }
    } catch (err) {
      consecutiveErrors++;
      console.warn(`\n⚠️  خطأ في حلقة الوكيل: ${err.message}`);
      if (consecutiveErrors >= 5) {
        console.error('❌ خمسة أخطاء متتالية. إيقاف الوكيل.');
        running = false;
        break;
      }
    }

    if (running) await sleep(POLL_SECONDS * 1000);
  }

  console.log('\n👋 الوكيل أوقف.');
  if (activeTaskId) {
    console.log(`⚠️  المهمة ${activeTaskId} كانت قيد التنفيذ عند الإيقاف.`);
  }
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
