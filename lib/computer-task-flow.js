'use client';

/**
 * A computer task the assistant created: waits for the user's tap (approve / reject),
 * then follows it until the computer reports a result, which is handed to onResult
 * as a short Arabic summary. Same store pattern as send-actions.js.
 */
import { describeComputerTask, summarizeComputerResult } from './computer-tasks-client';

const POLL_MS = 2500;
const MAX_WAIT_MS = 11 * 60 * 1000; // tasks expire after 10 minutes on the server
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'rejected']);

let getAccessToken = async () => null;
let onResult = () => {};
let state = null; // { task, deviceLabel, description, status: confirm|deciding|waiting|done|error, error?, summary? }
let pollTimer = null;
let clearTimer = null;
const listeners = new Set();

export function configureComputerTasks(options = {}) {
  if (typeof options.getAccessToken === 'function') getAccessToken = options.getAccessToken;
  if (typeof options.onResult === 'function') onResult = options.onResult;
}

export function subscribeComputerTask(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function setState(next) {
  state = next;
  for (const listener of listeners) listener(state);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function clearLater(ms) {
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => setState(null), ms);
}

async function authorizedFetch(url, init = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('انتهت جلسة الدخول.');
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'تعذر الاتصال بخدمة الكمبيوتر.');
  return data;
}

/** Called with the assistant's { type: 'computer_task', task, deviceLabel } action. */
export function queueComputerTask(action) {
  if (action?.type !== 'computer_task' || !action.task?.id) return;
  stopPolling();
  clearTimeout(clearTimer);
  setState({
    task: action.task,
    deviceLabel: action.deviceLabel || 'الكمبيوتر',
    description: describeComputerTask(action.task),
    status: 'confirm',
  });
}

export async function decideComputerTask(decision) {
  if (!state || state.status !== 'confirm') return;
  const current = state;
  setState({ ...current, status: 'deciding' });
  try {
    await authorizedFetch(`/api/computer/tasks/${current.task.id}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (decision === 'rejected') {
      setState({ ...current, status: 'done', summary: 'أُلغيت مهمة الكمبيوتر.' });
      clearLater(2500);
      return;
    }
    setState({ ...current, status: 'waiting' });
    void follow(current.task.id, Date.now());
  } catch (error) {
    setState({ ...current, status: 'error', error: error?.message || 'تعذر تسجيل قرارك.' });
    clearLater(6000);
  }
}

export function dismissComputerTask() {
  stopPolling();
  setState(null);
}

async function follow(taskId, startedAt) {
  if (!state || state.task.id !== taskId) return;
  try {
    const data = await authorizedFetch('/api/computer/tasks');
    const task = Array.isArray(data.tasks) ? data.tasks.find((item) => item.id === taskId) : null;
    if (task && FINAL.has(task.status)) {
      const summary = summarizeComputerResult(task) || 'انتهت مهمة الكمبيوتر.';
      setState({ ...state, task: { ...state.task, ...task }, status: 'done', summary });
      onResult({ ok: task.status === 'succeeded', task, summary });
      clearLater(12_000);
      return;
    }
  } catch {
    // Network blip: keep following until the deadline.
  }
  if (Date.now() - startedAt > MAX_WAIT_MS) {
    const summary = 'لم يرد الكمبيوتر. تأكد أن تطبيق الكمبيوتر مفتوح و«استقبال المهام» يعمل.';
    setState({ ...state, status: 'done', summary });
    onResult({ ok: false, summary });
    clearLater(12_000);
    return;
  }
  pollTimer = setTimeout(() => void follow(taskId, startedAt), POLL_MS);
}
