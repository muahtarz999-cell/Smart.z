'use client';

import { useEffect } from 'react';

export default function ForegroundKeepAlive() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const registerWorker = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/service-worker.js');
        const heartbeat = () => {
          if (!registration.active) return;
          registration.active.postMessage({ type: 'KEEP_ALIVE' });
        };

        heartbeat();
        const interval = setInterval(heartbeat, 30000);

        const onMessage = (event) => {
          if (event.data?.type === 'HEARTBEAT') {
            // Keep the page alive while still in foreground.
          }
        };

        navigator.serviceWorker.addEventListener('message', onMessage);

        return () => {
          clearInterval(interval);
          navigator.serviceWorker.removeEventListener('message', onMessage);
        };
      } catch (error) {
        console.warn('[KeepAlive] Service worker registration failed:', error);
      }
    };

    const cleanup = registerWorker();
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  return null;
}
