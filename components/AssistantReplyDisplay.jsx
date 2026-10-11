'use client';

import { useState, useEffect } from 'react';
import AssistantOrb from './AssistantOrb';

/**
 * مكون عرض رد المساعد مع خط صوتي وخط كبير
 */
export default function AssistantReplyDisplay({ reply, isLoading, orbState }) {
  const [displayedText, setDisplayedText] = useState('');
  const [isAnimating, setIsAnimating] = useState(false);

  // تأثير الكتابة (typing animation)
  useEffect(() => {
    if (!reply) {
      setDisplayedText('');
      setIsAnimating(false);
      return;
    }

    setIsAnimating(true);
    let index = 0;

    const interval = setInterval(() => {
      if (index < reply.length) {
        setDisplayedText(reply.substring(0, index + 1));
        index++;
      } else {
        clearInterval(interval);
        setIsAnimating(false);
      }
    }, 30); // سرعة الكتابة

    return () => clearInterval(interval);
  }, [reply]);

  // إظهار الموجة الصوتية عند التحدث أو التفكير
  const showWaveform = orbState === 'speaking' || orbState === 'thinking' || isLoading;

  return (
    <div className="flex flex-col items-center justify-center w-full px-4 py-8 gap-6">
      {/* الرسم الحركي - كرة أو موجة */}
      <div className="flex justify-center">
        <AssistantOrb
          size={showWaveform ? 240 : 128}
          listening={orbState === 'listening' || orbState === 'listening-active'}
          showWaveform={showWaveform}
        />
      </div>

      {/* عرض النص مع خط كبير */}
      {(displayedText || isLoading) && (
        <div className="w-full max-w-2xl">
          <div className="rounded-lg border border-gold/20 bg-gradient-to-b from-gold/5 to-transparent p-6">
            {/* نص الرد - خط كبير واضح */}
            <p
              className="
                text-2xl leading-relaxed text-text-primary
                font-medium text-right
                min-h-24 break-words
              "
              style={{
                direction: 'rtl',
                wordWrap: 'break-word',
                overflowWrap: 'break-word',
                whiteSpace: 'pre-wrap',
              }}
            >
              {displayedText}
              {isAnimating && (
                <span className="inline-block w-1 h-8 ml-1 bg-gold animate-pulse" />
              )}
            </p>

            {/* مؤشر التحميل */}
            {isLoading && !displayedText && (
              <div className="flex items-center justify-center gap-2">
                <div className="h-2 w-2 rounded-full bg-gold animate-bounce" />
                <div className="h-2 w-2 rounded-full bg-gold animate-bounce animation-delay-200" />
                <div className="h-2 w-2 rounded-full bg-gold animate-bounce animation-delay-400" />
                <span className="ml-2 text-sm text-gold">جاري التفكير...</span>
              </div>
            )}
          </div>

          {/* معلومات إضافية */}
          {!isLoading && displayedText && !isAnimating && (
            <p className="mt-3 text-center text-xs text-text-secondary">
              {orbState === 'speaking' ? '🔊 النطق الصوتي جارٍ...' : '✓ اكتمل الرد'}
            </p>
          )}
        </div>
      )}

      {/* رسالة إذا لم يكن هناك رد */}
      {!displayedText && !isLoading && (
        <p className="text-text-secondary text-sm text-center">
          {orbState === 'listening' ? 'قل لي بماذا أساعدك' : 'في انتظار رسالتك...'}
        </p>
      )}
    </div>
  );
}
