'use client';

/**
 * Turns a picked or photographed file into what the app stores locally:
 * a file record (original kept for export, a small thumbnail, and for images a
 * compressed copy used for analysis) plus text chunks for on-device search.
 * Nothing here touches the network.
 */

import { readZip } from './zip';
import { chunkPages } from './local-search';
import { newId } from './idb';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ANALYSIS_EDGE = 1600;
const THUMB_EDGE = 240;
const SCANNED_CHARS_PER_PAGE = 30;
const DOCX_PSEUDO_PAGE = 3000;

export class FileProcessingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function detectKind(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  if (type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif)$/.test(name)) return 'image';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (type.startsWith('text/') || /\.(txt|md|csv)$/.test(name)) return 'text';
  return null;
}

async function loadImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new FileProcessingError('IMAGE_DECODE', 'تعذر فتح الصورة على هذا الجهاز (صيغة HEIC قد لا تكون مدعومة؛ جرّب JPG).')); };
    image.src = url;
  });
}

/** Draws `source` scaled to fit `edge`, optionally enhancing contrast for documents. */
export async function renderToJpeg(source, edge, { quality = 0.8, enhance = false } = {}) {
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (enhance) context.filter = 'contrast(1.25) brightness(1.05)';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------- PDF (pdf.js, loaded only when needed)
let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      if (typeof Promise.withResolvers !== 'function') {
        Promise.withResolvers = function withResolvers() {
          let resolve; let reject;
          const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
          return { promise, resolve, reject };
        };
      }
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      return pdfjs;
    })().catch((error) => { pdfjsPromise = null; throw error; });
  }
  return pdfjsPromise;
}

async function openPdf(blob) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
}

async function extractPdfPages(blob) {
  const pdf = await openPdf(blob);
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim());
  }
  return { pages, pdf };
}

/** Renders one PDF page to a JPEG Blob (for scanned PDFs sent to the vision model). */
export async function renderPdfPage(blob, pageNumber, edge = ANALYSIS_EDGE) {
  const pdf = await openPdf(blob);
  const number = Math.min(Math.max(1, pageNumber), pdf.numPages);
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(3, edge / Math.max(base.width, base.height)) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

// ---------------------------------------------------------------- DOCX (own zip reader, no dependency)
function decodeXml(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export async function extractDocxText(bytes) {
  const entries = readZip(bytes);
  const read = entries.get('word/document.xml');
  if (!read) throw new FileProcessingError('BAD_DOCX', 'ملف Word غير صالح.');
  const xml = new TextDecoder().decode(await read());
  return xml.split(/<\/w:p>/).map((paragraph) => {
    const runs = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)];
    return runs.map((run) => (run[1] !== undefined ? decodeXml(run[1]) : ' ')).join('');
  }).map((line) => line.trim()).filter(Boolean);
}

export async function extractPlainText(file) {
  const kind = detectKind(file);
  if (kind === 'pdf') {
    let extracted;
    try { extracted = await extractPdfPages(file); } catch { throw new FileProcessingError('BAD_PDF', 'تعذر قراءة ملف PDF (قد يكون محمياً بكلمة مرور).'); }
    return extracted.pages.join('\n');
  }
  if (kind === 'docx') return (await extractDocxText(new Uint8Array(await file.arrayBuffer()))).join('\n');
  if (kind === 'text') return file.text();
  throw new FileProcessingError('UNSUPPORTED', 'المدعوم لاستيراد الأنظمة: PDF أو Word أو نص.');
}

function paragraphsToPseudoPages(paragraphs) {
  const pages = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if ((current + paragraph).length > DOCX_PSEUDO_PAGE && current) { pages.push(current); current = ''; }
    current += `${paragraph}\n`;
  }
  if (current.trim()) pages.push(current);
  return pages;
}

// ---------------------------------------------------------------- entry point
/**
 * Returns { record, chunks }. `fromCamera` enhances contrast for documents.
 */
export async function processFile(file, { fromCamera = false } = {}) {
  const kind = detectKind(file);
  if (!kind) throw new FileProcessingError('UNSUPPORTED', 'نوع الملف غير مدعوم. المدعوم: الصور، PDF، Word، والنصوص.');
  if (file.size > MAX_FILE_BYTES) throw new FileProcessingError('TOO_LARGE', 'حجم الملف أكبر من 50 ميجابايت.');

  const now = Date.now();
  const record = {
    id: newId('file'),
    name: file.name || (fromCamera ? `صورة ${new Date(now).toLocaleString('ar')}` : 'ملف'),
    type: file.type || '',
    kind,
    size: file.size,
    createdAt: now,
    updatedAt: now,
    pageCount: 1,
    scanned: false,
    blob: file,
    analysisBlob: null,
    thumbnail: null,
  };
  let pages = [];

  if (kind === 'image') {
    const image = await loadImage(file);
    record.analysisBlob = await renderToJpeg(image, ANALYSIS_EDGE, { enhance: fromCamera });
    record.thumbnail = await renderToJpeg(image, THUMB_EDGE, { quality: 0.7 });
    if (fromCamera) record.blob = record.analysisBlob; // the camera original is huge and adds nothing
  } else if (kind === 'pdf') {
    let extracted;
    try {
      extracted = await extractPdfPages(file);
    } catch {
      throw new FileProcessingError('BAD_PDF', 'تعذر قراءة ملف PDF (قد يكون محمياً بكلمة مرور).');
    }
    pages = extracted.pages;
    record.pageCount = pages.length;
    const characters = pages.reduce((sum, text) => sum + text.length, 0);
    record.scanned = characters / Math.max(1, pages.length) < SCANNED_CHARS_PER_PAGE;
    try { record.thumbnail = await renderPdfPage(file, 1, THUMB_EDGE); } catch {}
    if (record.scanned) pages = [];
  } else if (kind === 'docx') {
    pages = paragraphsToPseudoPages(await extractDocxText(new Uint8Array(await file.arrayBuffer())));
    record.pageCount = pages.length || 1;
  } else {
    pages = paragraphsToPseudoPages((await file.text()).split(/\n+/));
    record.pageCount = pages.length || 1;
  }

  const chunks = chunkPages(pages).map((chunk) => ({ ...chunk, id: `${record.id}:${chunk.page}:${chunk.index}`, fileId: record.id }));
  return { record, chunks };
}
