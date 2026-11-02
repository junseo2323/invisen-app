// App state + persistence. Preferences = UserDefaults on iOS, localStorage on web.
import { Preferences } from '@capacitor/preferences';
import type { Level, Me, Status } from '../server/src/api-types';

export const storage = {
  async get<V>(key: string, fallback: V): Promise<V> {
    try {
      const { value } = await Preferences.get({ key });
      return value == null ? fallback : (JSON.parse(value) as V);
    } catch {
      return fallback;
    }
  },
  async set(key: string, value: unknown) {
    try {
      await Preferences.set({ key, value: JSON.stringify(value) });
    } catch {
      /* ignore */
    }
  },
  async remove(key: string) {
    try {
      await Preferences.remove({ key });
    } catch {
      /* ignore */
    }
  },
};

export type SensorLink = 'off' | 'scanning' | 'connecting' | 'connected' | 'reconnecting';

export interface Live {
  ts: number;
  pm10: number;
  pm25: number | null;
  co: number | null;
  temp: number | null;
  humidity: number | null;
  level: Level;
}

export interface Prefs {
  vibe: boolean;
  big: boolean;
  light: boolean;
}

export interface AppState {
  token: string | null;
  onboarded: boolean;
  me: Me | null;
  status: Status | null;
  live: Live | null;
  link: SensorLink;
  /** BLE device id of the paired sensor on this phone. */
  deviceId: string | null;
  battery: number | null;
  rssi: number | null;
  prefs: Prefs;
  /** SOS in progress (id from the server) */
  sos: { id: number; time: string } | null;
}

const listeners = new Set<() => void>();

export const app = {
  state: {
    token: null,
    onboarded: false,
    me: null,
    status: null,
    live: null,
    link: 'off',
    deviceId: null,
    battery: null,
    rssi: null,
    prefs: { vibe: true, big: false, light: false },
    sos: null,
  } as AppState,

  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    listeners.forEach((fn) => fn());
  },

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async load() {
    this.set({
      token: await storage.get<string | null>('token', null),
      onboarded: await storage.get('onboarded', false),
      deviceId: await storage.get<string | null>('deviceId', null),
      prefs: { ...this.state.prefs, ...(await storage.get<Partial<Prefs>>('prefs', {})) },
    });
  },

  async persist(patch: Partial<Pick<AppState, 'token' | 'onboarded' | 'deviceId' | 'prefs'>>) {
    this.set(patch);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null) await storage.remove(k);
      else await storage.set(k, v);
    }
  },
};
