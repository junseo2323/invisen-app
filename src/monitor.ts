// Runs while a worker is signed in: keeps the sensor connected, shows live values,
// uploads readings (queued offline), refreshes status, and raises alerts.
import { api, ApiError } from './api';
import { app, storage } from './store';
import { sensor, type SensorReading } from './sensor';
import { haptics, isForeground, notifyLocal, onAppState, registerPush } from './native';
import type { Level, ReadingIn } from '../server/src/api-types';

const UPLOAD_EVERY_MS = 15_000;
const STATUS_EVERY_MS = 30_000;
const MAX_QUEUE = 5000;
const CAUTION = 0.8;

let queue: ReadingIn[] = [];
let recent: { ts: number; pm10: number; pm25: number | null; co: number | null }[] = [];

/** Readings from the last 30 minutes on this phone (for the sparklines). */
export const history = () => recent;
let uploadTimer: number | undefined;
let statusTimer: number | undefined;
let reconnectTimer: number | undefined;
let reconnectDelay = 3000;
let running = false;
let lastLevel: Level = 'safe';
let dangerShownAt = 0;

export const levelOf = (v: number, limit: number): Level => (v / limit >= 1 ? 'danger' : v / limit >= CAUTION ? 'caution' : 'safe');

function limit() {
  return app.state.status?.zone?.limit ?? 100;
}

function onReading(r: SensorReading) {
  const level = levelOf(r.pm10, limit());
  app.set({
    link: 'connected',
    live: { ts: r.ts, pm10: r.pm10, pm25: r.pm25 ?? null, co: r.co ?? null, temp: r.temp ?? null, humidity: r.humidity ?? null, level },
  });
  recent.push({ ts: r.ts, pm10: r.pm10, pm25: r.pm25 ?? null, co: r.co ?? null });
  recent = recent.filter((x) => x.ts > r.ts - 30 * 60_000);
  queue.push({ ts: new Date(r.ts).toISOString(), pm10: r.pm10, pm25: r.pm25, co: r.co, temp: r.temp, humidity: r.humidity });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  react(level, r.pm10);
}

/** Alerts on level changes: caution → notification + haptic, danger → full-screen alert. */
function react(level: Level, pm10: number) {
  const prev = lastLevel;
  lastLevel = level;
  if (level === prev) return;
  const zone = app.state.status?.zone?.name ?? '';
  const vibe = app.state.prefs.vibe;
  if (level === 'danger') {
    if (vibe) haptics.pattern([400, 100, 400, 100, 400]);
    void notifyLocal('위험 · 지금 바로 나와주세요', `${zone} PM10 ${Math.round(pm10)} µg/m³`, '#alert-danger');
    // don't re-open the alert more than once a minute
    if (Date.now() - dangerShownAt > 60_000) {
      dangerShownAt = Date.now();
      location.hash = '#alert-danger';
    }
  } else if (level === 'caution' && prev === 'safe') {
    if (vibe) haptics.warn();
    if (!isForeground()) void notifyLocal('주의 · 마스크를 써주세요', `${zone} PM10 ${Math.round(pm10)} µg/m³`, '#home');
  }
}

async function flush() {
  const sensorId = app.state.me?.sensor?.id;
  if (!queue.length || !sensorId) return;
  const batch = queue.slice(0, 500);
  try {
    await api.postReadings({ sensorId, battery: app.state.battery ?? undefined, readings: batch });
    queue = queue.slice(batch.length);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'sensor_not_paired') queue = [];
    // network errors: keep the batch and retry next round
  }
  await storage.set('queue', queue);
}

export async function refreshStatus() {
  try {
    app.set({ status: await api.status() });
  } catch {
    /* keep last */
  }
}

async function connect() {
  const deviceId = app.state.deviceId;
  if (!running || !deviceId) return;
  clearTimeout(reconnectTimer);
  app.set({ link: app.state.link === 'off' ? 'connecting' : 'reconnecting' });
  try {
    await sensor.connect(deviceId, {
      onReading,
      onBattery: (battery) => app.set({ battery }),
      onDisconnect: () => {
        app.set({ link: 'reconnecting' });
        scheduleReconnect();
      },
    });
    reconnectDelay = 3000;
    app.set({ link: 'connected' });
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!running) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

export async function startMonitor() {
  if (running) return;
  running = true;
  queue = await storage.get<ReadingIn[]>('queue', []);
  await refreshStatus();
  lastLevel = app.state.status?.now?.level ?? 'safe';
  void connect();
  uploadTimer = window.setInterval(flush, UPLOAD_EVERY_MS);
  statusTimer = window.setInterval(refreshStatus, STATUS_EVERY_MS);
  void registerPush((token) => void api.pushToken(token).catch(() => {}));
}

export async function stopMonitor() {
  running = false;
  clearInterval(uploadTimer);
  clearInterval(statusTimer);
  clearTimeout(reconnectTimer);
  await flush();
  await sensor.disconnect();
  queue = [];
  recent = [];
  await storage.remove('queue');
  app.set({ link: 'off', live: null });
}

/** Re-connect after pairing a different sensor. */
export async function reconnectSensor() {
  await sensor.disconnect();
  if (running) void connect();
}

onAppState((active) => {
  if (!running) return;
  if (active) {
    void refreshStatus();
    if (app.state.link !== 'connected') void connect();
  } else {
    void flush();
  }
});
