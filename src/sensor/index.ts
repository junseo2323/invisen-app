import { Capacitor } from '@capacitor/core';
import { app } from '../store';
import { bleDriver } from './ble';
import { simDriver } from './sim';
import type { SensorDriver } from './types';

// Real Bluetooth inside the iOS app; the simulator in the browser, when built with
// VITE_SENSOR=sim (the iOS simulator has no Bluetooth), and for demo / App Store review accounts.
const nativeBle = Capacitor.isNativePlatform() && import.meta.env.VITE_SENSOR !== 'sim';
const pick = (): SensorDriver => (nativeBle && !app.state.me?.demo ? bleDriver : simDriver);

export const sensor: SensorDriver = {
  get kind() {
    return pick().kind;
  },
  ensureReady: () => pick().ensureReady(),
  scan: (onFound, ms) => pick().scan(onFound, ms),
  stopScan: () => pick().stopScan(),
  connect: (deviceId, handlers) => pick().connect(deviceId, handlers),
  disconnect: async () => {
    await bleDriver.disconnect();
    await simDriver.disconnect();
  },
};

export type { FoundSensor, SensorReading } from './types';
