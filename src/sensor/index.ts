import { Capacitor } from '@capacitor/core';
import { bleDriver } from './ble';
import { simDriver } from './sim';
import type { SensorDriver } from './types';

// Real Bluetooth inside the iOS app; simulator in the browser, or when built with VITE_SENSOR=sim
// (the iOS simulator has no Bluetooth).
export const sensor: SensorDriver =
  Capacitor.isNativePlatform() && import.meta.env.VITE_SENSOR !== 'sim' ? bleDriver : simDriver;

export type { FoundSensor, SensorReading } from './types';
