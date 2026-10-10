'use client';

import { useState, useEffect } from 'react';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showAndroidPrompt, setShowAndroidPrompt] = useState(false);
  const [showiOSPrompt, setShowiOSPrompt] = useState(false);

  useEffect(() => {
    // تسجيل Service Worker
    let wasControlled = false;
    let isReloadingForUpdate = false;
    const handleControllerChange = () => {
      if (wasControlled && !isReloadingForUpdate) {
        isReloadingForUpdate = true;
        window.location.reload();
      }
      wasControlled = true;
    };

    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      wasControlled = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
    }

    // التقاط حدث beforeinstallprompt في Android و Chrome
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      // إظهار الشريط العائم بعد ثانيتين
      setTimeout(() => setShowAndroidPrompt(true), 2000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // اكتشاف نظام iOS وحالة التشغيل المستقل (PWA)
    const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

    if (isiOS && !isStandalone) {
      setTimeout(() => setShowiOSPrompt(true), 3000);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
      }
    };
  }, []);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        console.log('[PWA] تم قبول التثبيت من قبل المستخدم');
      }
      setDeferredPrompt(null);
      setShowAndroidPrompt(false);
    }
  };

  const handleClosePrompt = () => {
    setShowAndroidPrompt(false);
    setShowiOSPrompt(false);
  };

  return (
    <>
      {/* شريط التثبيت العائم لنظام Android */}
      {showAndroidPrompt && (
        <div className="fixed bottom-4 left-4 right-4 bg-base-card/95 backdrop-blur-md p-3.5 rounded-xl shadow-2xl flex items-center justify-between z-50 border border-gold/30 animate-slide-up-fade">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon-192x192.png" alt="Smart.z Icon" className="w-11 h-11 rounded-lg border border-gold/20" />
            <div>
              <h4 className="font-bold text-sm text-text-primary">تثبيت Smart.z</h4>
              <p className="text-xs text-text-secondary">ثبّت التطبيق على الشاشة الرئيسية للوصول الفوري السريع!</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleInstallClick}
              className="bg-gold hover:bg-gold-light text-base-bg text-xs font-bold rounded-lg px-3.5 py-2 transition-colors shadow-sm"
            >
              تثبيت الآن
            </button>
            <button
              type="button"
              onClick={handleClosePrompt}
              className="text-text-secondary hover:text-text-primary p-1"
              aria-label="إغلاق"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* دليل التثبيت التفاعلي لنظام iOS */}
      {showiOSPrompt && (
        <div
          className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-6 animate-fade-in"
          onClick={handleClosePrompt}
        >
          <div
            className="bg-base-card border border-gold/30 p-6 rounded-2xl shadow-2xl w-full max-w-sm text-center relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={handleClosePrompt}
              className="absolute top-3 right-3 text-text-secondary hover:text-text-primary p-1"
              aria-label="إغلاق"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/apple-touch-icon.png" alt="Smart.z Icon" className="w-18 h-18 rounded-2xl mx-auto mb-3 shadow-lg border border-gold/20" />
            <h3 className="font-bold text-lg text-text-primary mb-1">ثبّت Smart.z على iPhone</h3>
            <p className="text-xs text-text-secondary mb-5">اتبع الخطوتين لإضافة التطبيق كـ PWA مستقل على شاشتك:</p>
            
            <div className="flex flex-col gap-3 text-right">
              <div className="flex items-start gap-3 bg-base-panel p-2.5 rounded-lg border border-base-border">
                <span className="bg-gold/20 border border-gold/40 text-gold font-bold rounded-full w-6 h-6 flex items-center justify-center text-xs shrink-0 mt-0.5">1</span>
                <p className="text-xs text-text-primary flex-1 leading-5">
                  انقر على زر المشاركة <span className="inline-block px-1.5 py-0.5 bg-base-card rounded border border-base-border text-gold mx-1 font-mono">⎋ Share</span> في شريط Safari السفلي.
                </p>
              </div>
              
              <div className="flex items-start gap-3 bg-base-panel p-2.5 rounded-lg border border-base-border">
                <span className="bg-gold/20 border border-gold/40 text-gold font-bold rounded-full w-6 h-6 flex items-center justify-center text-xs shrink-0 mt-0.5">2</span>
                <p className="text-xs text-text-primary flex-1 leading-5">
                  اختر <span className="text-gold font-semibold mx-1">«إضافة إلى الشاشة الرئيسية ⊞»</span> من القائمة.
                </p>
              </div>
            </div>

            {/* سهم متحرك يتجه لأسفل نحو شريط Safari */}
            <div className="mt-5 flex justify-center animate-bounce">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="#C9A868" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
              </svg>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
