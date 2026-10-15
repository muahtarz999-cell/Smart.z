'use client';

/**
 * Study tools on a file's text, kept on the device. Long scopes are
 * summarised in stages (batches, then a summary of the summaries) so large
 * books fit the model's context; quizzes and cards sample passages evenly.
 */

import { getAllByIndex, newId, putRecord, getRecord, deleteRecord } from './idb';
import { getChunksInRange } from './file-store';
import { newReview, reviewCard, isDue } from './spaced-repetition';
import { saveLocalRecord, listLocalRecords } from './local-data';
import { synchronizeTaskReminders } from './task-notifications';

const BATCH_CHARACTERS = 10_000;
const SINGLE_CALL_CHARACTERS = 12_000;

async function callStudy(getAccessToken, payload) {
  const token = await getAccessToken();
  if (!token) throw new Error('انتهت جلسة الدخول.');
  const response = await fetch('/api/study', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.result) throw new Error(data.message || 'تعذر تجهيز أداة المذاكرة.');
  return data.result;
}

const size = (chunks) => chunks.reduce((sum, c) => sum + c.text.length, 0);

/** Evenly spread chunks up to `limit` characters (for quizzes/cards over long scopes). */
export function sampleEvenly(chunks, limit = SINGLE_CALL_CHARACTERS) {
  if (size(chunks) <= limit) return chunks;
  const average = size(chunks) / chunks.length;
  const count = Math.max(1, Math.floor(limit / average));
  const step = chunks.length / count;
  return Array.from({ length: count }, (_, i) => chunks[Math.floor(i * step)]);
}

export function batchChunks(chunks, limit = BATCH_CHARACTERS) {
  const batches = [];
  let current = [];
  let total = 0;
  for (const chunk of chunks) {
    if (total + chunk.text.length > limit && current.length) { batches.push(current); current = []; total = 0; }
    current.push(chunk);
    total += chunk.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function scopeLabel(file, from, to) {
  return from || to ? `${file.name} — الصفحات ${from || 1} إلى ${to || file.pageCount}` : file.name;
}

/**
 * type: summary | explain | quiz | cards | mindmap
 * onProgress(text) reports stages for long summaries.
 */
export async function runStudyTool({ getAccessToken, file, from, to, type, options = {}, onProgress }) {
  const chunks = await getChunksInRange(file.id, from, to);
  if (!chunks.length) throw new Error('لا يوجد نص في هذا النطاق.');
  const label = scopeLabel(file, from, to);
  const passages = (list) => list.map(({ page, text }) => ({ page, text }));

  let result;
  if (type === 'summary' && size(chunks) > SINGLE_CALL_CHARACTERS) {
    const batches = batchChunks(chunks);
    const partials = [];
    for (const [index, batch] of batches.entries()) {
      onProgress?.(`تلخيص الجزء ${index + 1} من ${batches.length}…`);
      partials.push(await callStudy(getAccessToken, { type: 'summary', passages: passages(batch), scopeLabel: label, options: { length: 'short' } }));
    }
    onProgress?.('دمج الملخصات…');
    const merged = partials.flatMap((p) => p.points.map((point) => ({ page: point.page, text: point.text })));
    result = await callStudy(getAccessToken, { type: 'summary', passages: merged, scopeLabel: label, options });
  } else {
    const source = type === 'summary' ? chunks : sampleEvenly(chunks);
    result = await callStudy(getAccessToken, { type, passages: passages(source), scopeLabel: label, options });
  }

  const set = { id: newId('study'), fileId: file.id, fileName: file.name, from: from || null, to: to || null, type, result, createdAt: Date.now() };
  await putRecord('studySets', set);
  return set;
}

export async function listStudySets(fileId) {
  return (await getAllByIndex('studySets', 'fileId', fileId)).sort((a, b) => b.createdAt - a.createdAt);
}

export const deleteStudySet = (id) => deleteRecord('studySets', id);

// ---------------------------------------------------------------- cards
export async function dueCards(set, now = Date.now()) {
  const reviews = await getAllByIndex('cardReviews', 'setId', set.id);
  const byId = new Map(reviews.map((r) => [r.id, r]));
  return set.result.cards
    .map((card, index) => ({ card, id: `${set.id}:${index}`, review: byId.get(`${set.id}:${index}`) }))
    .filter((entry) => isDue(entry.review, now));
}

export async function gradeCard(setId, cardId, grade) {
  const current = (await getRecord('cardReviews', cardId)) || newReview(cardId, setId);
  return putRecord('cardReviews', reviewCard(current, grade));
}

// ---------------------------------------------------------------- study plan
/**
 * Splits the pages until the exam into daily tasks with local reminders at `hour`.
 * Returns the created tasks.
 */
export async function createStudyPlan({ file, examDate, from = 1, to, hour = 19, reviewDays = 1 }) {
  const last = to || file.pageCount || 1;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const exam = new Date(examDate);
  exam.setHours(0, 0, 0, 0);
  const totalDays = Math.round((exam - start) / 86_400_000);
  const studyDays = Math.max(1, totalDays - reviewDays);
  if (totalDays < 1) throw new Error('اختر تاريخ اختبار بعد اليوم.');
  const pages = last - from + 1;
  const perDay = Math.ceil(pages / studyDays);
  const tasks = [];
  for (let day = 0, page = from; page <= last; day += 1, page += perDay) {
    const end = Math.min(last, page + perDay - 1);
    const at = new Date(start.getTime() + day * 86_400_000);
    at.setHours(hour, 0, 0, 0);
    if (at.getTime() <= Date.now()) at.setTime(Date.now() + 60 * 60 * 1000);
    tasks.push(await saveLocalRecord('tasks', {
      title: `مذاكرة ${file.name}: الصفحات ${page}–${end}`,
      details: `خطة مذاكرة حتى اختبار ${exam.toLocaleDateString('ar')}`,
      completed: false,
      reminderAt: at.toISOString(),
    }));
  }
  for (let r = 1; r <= reviewDays; r += 1) {
    const at = new Date(exam.getTime() - r * 86_400_000);
    at.setHours(hour, 0, 0, 0);
    if (at.getTime() > Date.now()) {
      tasks.push(await saveLocalRecord('tasks', { title: `مراجعة شاملة: ${file.name}`, details: 'استخدم بطاقات المراجعة والاختبار', completed: false, reminderAt: at.toISOString() }));
    }
  }
  try { await synchronizeTaskReminders(await listLocalRecords('tasks')); } catch {}
  return { tasks, perDay };
}
