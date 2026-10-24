'use client';

import { useEffect, useState } from 'react';
import { detectPairingRole } from '../lib/pairing-role';

// Lets the user pick which side of the pairing this device plays:
// the computer shows a QR code (/computer/pair), the phone scans it (/computer/approve).
export default function ComputerPairingChooser() {
  const [role, setRole] = useState(null);

  useEffect(() => {
    setRole(detectPairingRole(window));
  }, []);

  const primary = 'flex min-h-14 w-full flex-col items-start justify-center rounded-lg bg-gold px-5 py-3 text-right text-base-bg';
  const secondary = 'flex min-h-14 w-full flex-col items-start justify-center rounded-lg border border-base-border px-5 py-3 text-right text-text-primary';

  const showQr = (
    <a key="pair" href="/computer/pair" className={role === 'phone' ? secondary : primary}>
      <span className="text-sm font-semibold">أنا على الكمبيوتر — اعرض رمز QR</span>
      <span className="mt-1 text-xs opacity-80">يولّد رمز اقتران على هذه الشاشة لتمسحه من هاتفك.</span>
    </a>
  );
  const scan = (
    <a key="approve" href="/computer/approve" className={role === 'phone' ? primary : secondary}>
      <span className="text-sm font-semibold">أنا على الهاتف — امسح رمز الكمبيوتر</span>
      <span className="mt-1 text-xs opacity-80">يفتح الكاميرا لمسح الرمز الظاهر على الكمبيوتر والموافقة عليه.</span>
    </a>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm leading-7 text-text-secondary">
        الربط يتم بين جهازين: افتح Smart.z على الكمبيوتر واختر «اعرض رمز QR»، ثم افتحه على الهاتف واختر «امسح رمز الكمبيوتر».
        يلزم تسجيل الدخول على الهاتف وصلاحية ربط الكمبيوتر.
      </p>
      <div className="space-y-3">
        {role === 'phone' ? [scan, showQr] : [showQr, scan]}
      </div>
      {role ? (
        <p className="text-xs text-text-secondary">
          {role === 'phone' ? 'يبدو أن هذا الجهاز هاتف، لذلك ظهر خيار المسح أولًا.' : 'يبدو أن هذا الجهاز كمبيوتر، لذلك ظهر خيار عرض الرمز أولًا.'}
        </p>
      ) : null}
    </div>
  );
}
