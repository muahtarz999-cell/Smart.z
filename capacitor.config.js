const appUrl = new URL('https://smart-z.pages.dev');

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
