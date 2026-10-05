'use client';

import { useState, useEffect } from 'react';
import { audioManager } from '../lib/audio-manager';

export default function AppReadinessCheck() {
  const [audioBlocked, setAudioBlocked] = useState(false);

  useEffect(() => {
    const checkEnvironment = async () => {
      const isBlocked = await audioManager.isAudioBlocked();
      setAudioBlocked(isBlocked);
    };

    checkEnvironment();

    // التجميع مع أول ضغطة للمستخدم في أي مكان في الصفحة
    const handleFirstInteraction = async () => {
      const unlocked = await audioManager.unlockAudio();
      if (unlocked) {
        setAudioBlocked(false);
        window.removeEventListener('click', handleFirstInteraction);
        window.removeEventListener('touchstart', handleFirstInteraction);
      }
    };

    window.addEventListener('click', handleFirstInteraction);
    window.addEventListener('touchstart', handleFirstInteraction);

    return () => {
      window.removeEventListener('click', handleFirstInteraction);
      window.removeEventListener('touchstart', handleFirstInteraction);
    };
  }, []);

  if (!audioBlocked) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 bg-amber-500 text-white p-3 rounded-lg shadow-lg flex items-center justify-between">
      <span className="text-sm font-medium">
        🔔 يرجى الضغط هنا لتفعيل التنبيهات الصوتية على هذا الجهاز.
      </span>
      <button
        type="button"
        onClick={async () => {
          await audioManager.unlockAudio();
          setAudioBlocked(false);
        }}
        className="bg-white text-amber-600 px-3 py-1 rounded-md text-xs font-bold hover:bg-amber-50 transition-colors"
      >
        تفعيل الصوت
      </button>
    </div>
  );
}

