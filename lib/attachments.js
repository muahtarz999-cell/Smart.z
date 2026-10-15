'use client';

/**
 * What to send with a question about an attached file:
 *   image / scanned PDF → { mode: 'vision', images: [base64 JPEG ≤3], fileName, pages? }
 *   PDF / Word / text   → { mode: 'text', documentContext: { name, passages: [{ page, text }] } }
 * Only the passages that answer the question leave the device.
 */

import { blobToBase64, renderPdfPage } from './file-processing';
import { findRelevantPassages, getFile } from './file-store';

const MAX_VISION_PAGES = 3;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Page numbers mentioned in a question: "الصفحة 5"، "ص ١٢"، "صفحة 3 و4". */
export function pagesMentioned(question) {
  const text = String(question || '').replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
  const match = text.match(/(?:صفح[هة]|صفحات|ص|page)\s*([\d\s،,و\-–]+)/i);
  if (!match) return [];
  const pages = new Set();
  for (const part of match[1].split(/[،,و\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)[-–](\d+)$/);
    if (range) for (let p = Number(range[1]); p <= Math.min(Number(range[2]), Number(range[1]) + 10); p += 1) pages.add(p);
    else if (/^\d+$/.test(part)) pages.add(Number(part));
  }
  return [...pages].filter((p) => p > 0);
}

export async function prepareAttachmentContext(attachmentId, question) {
  const file = await getFile(attachmentId);
  if (!file) return null;

  if (file.kind === 'image') {
    return { mode: 'vision', fileName: file.name, images: [await blobToBase64(file.analysisBlob || file.blob)] };
  }
  if (file.kind === 'pdf' && file.scanned) {
    const requested = pagesMentioned(question).filter((p) => p <= file.pageCount);
    const pages = (requested.length ? requested : [1]).slice(0, MAX_VISION_PAGES);
    const images = [];
    for (const page of pages) images.push(await blobToBase64(await renderPdfPage(file.blob, page)));
    return { mode: 'vision', fileName: file.name, images, pages, pageCount: file.pageCount };
  }
  const requested = pagesMentioned(question);
  const passages = await findRelevantPassages(file.id, requested.length ? `${question} ${requested.map((p) => `صفحة ${p}`).join(' ')}` : question);
  return { mode: 'text', documentContext: { name: file.name, pageCount: file.pageCount, passages } };
}
