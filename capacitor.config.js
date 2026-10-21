// The production app is deployed as a Cloudflare Worker. Keeping the APK on
// this URL ensures it opens the same current web app as the browser deployment
// (including computer pairing), instead of the retired Pages deployment.
const appUrl = new URL('https://smart-z.muahtarz999.workers.dev');

module.exports = {
  appId: 'com.smartz.assistant',
  appName: 'Smart.z',
  webDir: 'capacitor-shell',
  server: {
    url: appUrl.toString(),
    cleartext: false,
    allowNavigation: [appUrl.hostname],
  },
  android: {
    initialFocus: true,
    allowMixedContent: false,
  },
  ios: {
    preferredContentMode: 'mobile',
  },
};
