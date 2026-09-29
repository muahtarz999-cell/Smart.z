'use client';

import { useState } from 'react';
import AssistantOrb from '../components/AssistantOrb';

export default function Home() {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);

  const orbSize = expanded ? 190 : 128;
  const panelMaxWidth = expanded ? 420 : 340;

  async function sendMessage(text) {
    if (!text.trim()) return;
    setLoading(true);
    setReply('');
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      setReply(data.reply || 'حدث خطأ، حاول مجددًا.');
    } catch (err) {
      setReply('تعذر الاتصال بالمساعد الآن.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div
        className="w-full transition-all duration-300"
        style={{ maxWidth: panelMaxWidth }}
      >
        <div className="bg-base-panel rounded-2xl border border-base-border overflow-hidden flex flex-col min-h-[420px]">
          {/* الشريط العلوي */}
          <div className="flex items-center justify-between px-4 py-3">
            <button aria-label="القائمة" className="text-text-secondary">
              ☰
            </button>
            <span className="text-xs text-text-secondary">
              {loading ? 'جاري التفكير...' : 'يستمع الآن'}
            </span>
            <button
              aria-label={expanded ? 'تصغير الشاشة' : 'توسيع الشاشة'}
              onClick={() => setExpanded((e) => !e)}
              className="text-text-secondary"
            >
              {expanded ? '⤡' : '⤢'}
            </button>
          </div>

          {/* الكرة والترحيب */}
          <div className="flex-1 flex flex-col items-center justify-center px-6 py-6">
            <AssistantOrb size={orbSize} listening={!loading} />

            <p className="text-text-primary text-base font-medium mt-5">
              أهلًا بك
            </p>
            <p className="text-text-secondary text-xs mt-1 text-center">
              {reply || 'قل لي بماذا أساعدك'}
            </p>
          </div>

          {/* شريط الإدخال */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(message);
              setMessage('');
            }}
            className="flex items-center gap-2 px-4 py-3 border-t border-base-border"
          >
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="اسأل المساعد أي شيء"
              className="flex-1 bg-base-card border border-base-border text-text-primary rounded-lg h-10 px-3 text-sm text-right"
            />
            <button
              type="submit"
              className="w-10 h-10 rounded-full bg-gold flex items-center justify-center flex-shrink-0"
              aria-label="إرسال"
            >
              ➤
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
