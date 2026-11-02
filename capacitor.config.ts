import type { CapacitorConfig } from '@capacitor/cli';

// The iOS app is a WKWebView shell around the web app.
//   default                                               -> ships dist/ inside the app (works offline)
//   CAP_SERVER_URL=https://<app domain> npx cap sync ios  -> loads the app served by our eney.cloud instance
//   CAP_SERVER_URL=http://<lan-ip>:5173 npx cap sync ios  -> live-reload from `npm run dev`
const serverUrl = process.env.CAP_SERVER_URL;
const host = serverUrl ? new URL(serverUrl).hostname : undefined;

const config: CapacitorConfig = {
  appId: 'com.invisen.worker',
  appName: 'invisen',
  webDir: 'dist',
  backgroundColor: '#0b0e12',
  ios: {
    contentInset: 'never',
    backgroundColor: '#0b0e12',
    scrollEnabled: true,
  },
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith('http://'),
        allowNavigation: [host!, `*.${host}`],
        // Shown from the bundle when the server can't be reached.
        errorPath: 'offline.html',
      }
    : undefined,
  plugins: {
    StatusBar: { style: 'DARK', overlaysWebView: true },
    PushNotifications: { presentationOptions: ['banner', 'sound', 'list'] },
    LocalNotifications: { iconColor: '#2bd8f0' },
  },
};

export default config;
