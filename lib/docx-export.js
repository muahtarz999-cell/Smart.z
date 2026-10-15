/**
 * Arabic (right-to-left) Word documents without any dependency: the DOCX XML
 * parts are written by hand and zipped with lib/zip.js.
 *
 * Body format (what the drafting route returns): "# " title/heading, "## " sub-heading,
 * "1. " numbered clause, "- " bullet, **bold**, blank line between paragraphs.
 */
import { createZip } from './zip.js';

const FONT = 'Arial';

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function runs(text, { bold = false, size = 26 } = {}) {
  return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => {
    const isBold = bold || /^\*\*[^*]+\*\*$/.test(part);
    const value = part.replace(/^\*\*|\*\*$/g, '');
    return `<w:r><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>${isBold ? '<w:b/><w:bCs/>' : ''}`
      + `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:rtl/></w:rPr><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;
  }).join('');
}

function paragraph(text, { bold = false, size = 26, align = 'both', spacingAfter = 120, indent = 0 } = {}) {
  return `<w:p><w:pPr><w:bidi/><w:jc w:val="${align}"/><w:spacing w:after="${spacingAfter}" w:line="360" w:lineRule="auto"/>`
    + `${indent ? `<w:ind w:right="${indent}"/>` : ''}</w:pPr>${runs(text, { bold, size })}</w:p>`;
}

export function bodyToDocumentXml(title, body, { disclaimer } = {}) {
  const parts = [];
  if (title) parts.push(paragraph(title, { bold: true, size: 36, align: 'center', spacingAfter: 240 }));
  for (const raw of String(body || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ')) {
      const text = line.slice(2).trim();
      if (text !== title) parts.push(paragraph(text, { bold: true, size: 32, align: 'center', spacingAfter: 200 }));
    } else if (line.startsWith('## ')) parts.push(paragraph(line.slice(3), { bold: true, size: 28, spacingAfter: 120 }));
    else if (/^\d+[.)-]\s/.test(line)) parts.push(paragraph(line, { indent: 0 }));
    else if (/^[-•*]\s/.test(line)) parts.push(paragraph(`•\u00A0\u00A0${line.replace(/^[-•*]\s+/, '')}`, { indent: 360 }));
    else parts.push(paragraph(line));
  }
  if (disclaimer) parts.push(paragraph(disclaimer, { size: 20, spacingAfter: 0 }));
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1260" w:bottom="1440" w:left="1260" w:header="708" w:footer="708" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>`;
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '</Relationships>';

const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="26"/><w:szCs w:val="26"/><w:rtl/><w:lang w:val="ar-SA" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
  + '<w:pPrDefault><w:pPr><w:bidi/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:bidi/></w:pPr></w:style>'
  + '</w:styles>';

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${escapeXml(title || '')}</dc:title><dc:creator>Smart.z</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>';
}

/** Returns the .docx bytes. */
export function buildDocx({ title, body, disclaimer }) {
  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: bodyToDocumentXml(title, body, { disclaimer }) },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'docProps/core.xml', data: coreXml(title) },
  ]);
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function safeFileName(title) {
  return `${String(title || 'مستند').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'مستند'}.docx`;
}
