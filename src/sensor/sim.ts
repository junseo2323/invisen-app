// Simulated sensor for the browser and the iOS simulator (no Bluetooth there).
// ?sim=caution / ?sim=danger in the URL (or localStorage 'invisen.sim') picks a scenario.
import type { SensorDriver, SensorReading } from './types';
import { app } from '../store';

const SAMPLE = [
  { deviceId: 'sim-0142', id: 'IVS-P10-0142', rssi: -48, battery: 92 },
  { deviceId: 'sim-0157', id: 'IVS-P10-0157', rssi: -81, battery: 64 },
];
// demo / review accounts get their own sensors on the server (created with the review login)
const DEMO = [
  { deviceId: 'sim-demo-1', id: 'IVS-DEMO-0001', rssi: -48, battery: 90 },
  { deviceId: 'sim-demo-2', id: 'IVS-DEMO-0002', rssi: -81, battery: 70 },
];
const devices = () => (app.state.me?.demo ? DEMO : SAMPLE);

type Scenario = 'safe' | 'caution' | 'danger';
let override: Scenario | null = null;
export function setSimScenario(s: Scenario) {
  override = s;
  try {
    localStorage.setItem('invisen.sim', s);
  } catch {
    /* storage blocked */
  }
}

export function scenario(): Scenario {
  if (override) return override;
  const fromUrl = new URLSearchParams(location.search).get('sim') ?? location.hash.match(/[?&]sim=(\w+)/)?.[1];
  let v: string | null | undefined = fromUrl;
  try {
    if (fromUrl) localStorage.setItem('invisen.sim', fromUrl);
    v = v ?? localStorage.getItem('invisen.sim');
  } catch {
    /* storage blocked */
  }
  return v === 'caution' || v === 'danger' ? v : 'safe';
}

let timer: number | undefined;
let onDisconnect: (() => void) | null = null;

export const simDriver: SensorDriver = {
  kind: 'sim',
  async ensureReady() {
    return true;
  },
  async scan(onFound, ms = 1500) {
    for (const d of devices()) {
      await new Promise((r) => setTimeout(r, ms / 3));
      onFound({ ...d });
    }
  },
  async stopScan() {},
  async connect(deviceId, h) {
    await new Promise((r) => setTimeout(r, 600));
    const dev = devices().find((d) => d.deviceId === deviceId) ?? devices()[0];
    onDisconnect = h.onDisconnect;
    // test sensors (deviceId 'test:IVS-TEST-…') report the battery the server has for them
    h.onBattery(deviceId.startsWith('test:') ? (app.state.me?.sensor?.battery ?? dev.battery) : dev.battery);
    const emit = () => {
      const base = { safe: 38, caution: 86, danger: 164 }[scenario()];
      const t = Date.now();
      const noise = Math.sin(t / 7000) * 3 + (Math.random() - 0.5) * 2;
      const r: SensorReading = {
        ts: t,
        pm10: Math.max(1, Math.round(base + noise)),
        pm25: Math.max(1, Math.round(base * 0.55 + noise / 2)),
        co: Math.round((6 + Math.max(0, Math.sin(t / 45_000)) * 8) * 10) / 10,
        temp: 24.6,
        humidity: 48,
      };
      h.onReading(r);
    };
    emit();
    clearInterval(timer);
    timer = window.setInterval(emit, 5000);
  },
  async disconnect() {
    clearInterval(timer);
    onDisconnect = null;
  },
};

export const simulateDisconnect = () => {
  clearInterval(timer);
  onDisconnect?.();
};
