import './globals.css';
import AppReadinessCheck from '../components/AppReadinessCheck';
import InstallPrompt from '../components/InstallPrompt';

export const metadata = {
  title: 'Smart.z - المساعد الشخصي الذكي',
  description: 'Smart.z AI Voice Assistant',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Smart.z',
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
        <InstallPrompt />
      </body>
    </html>
  );
}
