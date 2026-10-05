import './globals.css';
import AppReadinessCheck from '../components/AppReadinessCheck';

export const metadata = {
  title: 'المساعد الشخصي',
  description: 'مساعد أعمال ذكي شخصي',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'المساعد',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0B0D12',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ar" dir="rtl">
      <body>
        {children}
        <AppReadinessCheck />
      </body>
    </html>
  );
}

