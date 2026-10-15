'use client';

/**
 * Hidden pickers for camera, gallery and files. Processes the file on the
 * device, saves it to "ملفاتي", and reports the saved record.
 * Usage: const intake = useRef(); <FileIntake ref={intake} onSaved=… />; intake.current.open('camera')
 */

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { processFile } from '../lib/file-processing';
import { saveProcessedFile } from '../lib/file-store';

const FileIntake = forwardRef(function FileIntake({ onSaved, onError, multiple = false }, ref) {
  const camera = useRef(null);
  const gallery = useRef(null);
  const files = useRef(null);
  const [busy, setBusy] = useState(false);

  useImperativeHandle(ref, () => ({
    open(kind) {
      ({ camera, gallery, files })[kind]?.current?.click();
    },
    get busy() { return busy; },
  }), [busy]);

  async function handle(event, fromCamera) {
    const picked = [...(event.target.files || [])];
    event.target.value = '';
    if (!picked.length) return;
    setBusy(true);
    try {
      for (const file of picked) {
        try {
          const record = await saveProcessedFile(await processFile(file, { fromCamera }));
          onSaved?.(record);
        } catch (error) {
          onError?.(error?.message || `تعذر حفظ ${file.name}.`);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => handle(e, true)} />
      <input ref={gallery} type="file" accept="image/*" multiple={multiple} hidden onChange={(e) => handle(e, false)} />
      <input ref={files} type="file" multiple={multiple} hidden
        accept=".pdf,.docx,.txt,.md,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/*"
        onChange={(e) => handle(e, false)} />
      {busy && (
        <div role="status" className="fixed inset-x-0 bottom-24 z-[70] mx-auto w-fit rounded-full border border-base-border bg-base-card px-4 py-2 text-xs text-text-primary shadow-lg">
          جارٍ تجهيز الملف على جهازك…
        </div>
      )}
    </>
  );
});

export default FileIntake;
