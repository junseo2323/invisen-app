/// <reference types="vite/client" />
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** API origin for the bundled iOS build, e.g. https://app.example.com ('' = same origin) */
  readonly VITE_API_URL?: string;
  /** 'sim' = use the simulated sensor even inside the native app (iOS simulator) */
  readonly VITE_SENSOR?: string;
}
