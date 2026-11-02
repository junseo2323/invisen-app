import type { CapacitorConfig } from '@capacitor/cli';

// The iOS app is a WKWebView shell around the web app hosted on eney.cloud.
//   default                      -> loads https://eney.cloud/ (deploy dist/ there)
//   CAP_SERVER_URL=http://<lan-ip>:5173 npx cap sync ios   -> live-reload from `npm run dev`
//   CAP_BUNDLED=1 npx cap sync ios                         -> ships dist/ inside the app (offline)
const bundled = process.env.CAP_BUNDLED === '1';
const serverUrl = process.env.CAP_SERVER_URL ?? 'https://eney.cloud';
const host = new URL(serverUrl).hostname;

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
  server: bundled
    ? undefined
    : {
        url: serverUrl,
        cleartext: serverUrl.startsWith('http://'),
        allowNavigation: [host, `*.${host}`],
        // Shown from the bundle when eney.cloud can't be reached.
        errorPath: 'offline.html',
      },
  plugins: {
    StatusBar: { style: 'DARK', overlaysWebView: true },
  },
};

export default config;
