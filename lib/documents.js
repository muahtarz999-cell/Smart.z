'use client';

/** Local documents ("مستنداتي"): stored on the device with the last 10 versions. */

import { deleteRecord, getAllRecords, getRecord, newId, putRecord } from './idb';
import { buildDocx, DOCX_MIME, safeFileName } from './docx-export';
import { getTemplate, LEGAL_DISCLAIMER } from './document-templates';
import { normalizeArabic } from './arabic-normalize';

const MAX_VERSIONS = 10;

export async function listDocuments() {
  return (await getAllRecords('documents')).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getDocument = (id) => getRecord('documents', id);
export const deleteDocument = (id) => deleteRecord('documents', id);

export async function saveDocument({ id, title, body, templateId, fields }, { keepVersion = true } = {}) {
  const now = Date.now();
  const existing = id ? await getDocument(id) : null;
  const versions = existing && keepVersion && existing.body !== body
    ? [{ body: existing.body, title: existing.title, at: existing.updatedAt }, ...(existing.versions || [])].slice(0, MAX_VERSIONS)
    : existing?.versions || [];
  return putRecord('documents', {
    id: existing?.id || newId('doc'),
    title: String(title || existing?.title || 'مستند').slice(0, 120),
    body: String(body || ''),
    templateId: templateId ?? existing?.templateId ?? null,
    fields: fields ?? existing?.fields ?? {},
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    versions,
  });
}

export function isContract(document) {
  return Boolean(getTemplate(document?.templateId)?.contract) || /عقد|اتفاقي/.test(document?.title || '');
}

/** Contracts always carry the legal disclaimer when exported. */
export function documentToDocx(document) {
  const bytes = buildDocx({ title: document.title, body: document.body, disclaimer: isContract(document) ? LEGAL_DISCLAIMER : undefined });
  return new File([bytes], safeFileName(document.title), { type: DOCX_MIME });
}

/** For "أرسل العقد لأحمد": a document whose title matches the words, else the latest one. */
export async function findDocumentByTitle(words) {
  const documents = await listDocuments();
  const wanted = normalizeArabic(words);
  if (wanted && wanted !== 'latest') {
    const match = documents.find((doc) => normalizeArabic(doc.title).includes(wanted) || wanted.includes(normalizeArabic(doc.title)));
    if (match) return match;
  }
  return documents[0] || null;
}

export async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch (error) { if (error?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Print-to-PDF with correct Arabic shaping (the browser lays out the text). */
export function printDocument(doc) {
  const escape = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  const lines = String(doc.body || '').split('\n').map((raw) => {
    const line = escape(raw.trim()).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    if (!line) return '';
    if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
    if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
    if (/^[-•*]\s/.test(line)) return `<p class="bullet">• ${line.replace(/^[-•*]\s+/, '')}</p>`;
    return `<p>${line}</p>`;
  }).join('');
  const disclaimer = isContract(doc) ? `<p class="note">${escape(LEGAL_DISCLAIMER)}</p>` : '';
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escape(doc.title)}</title>
<style>body{font-family:Arial,'Noto Naskh Arabic',sans-serif;line-height:1.9;margin:2.2cm;color:#111}h1{text-align:center;font-size:22pt}h2{font-size:15pt;margin-top:1.2em}p{margin:.35em 0;text-align:justify}.bullet{margin-right:1em}.note{margin-top:2em;font-size:9pt;color:#555}</style>
</head><body>${doc.body.trim().startsWith('# ') ? '' : `<h1>${escape(doc.title)}</h1>`}${lines}${disclaimer}</body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch {}
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}
