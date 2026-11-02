// GATT profile of the invisen wearable sensor.
//
// !!! PLACEHOLDER — 센서 제조사 GATT 사양을 받으면 UUID 와 패킷 해석을 교체하세요. !!!
// The app, uploader and alerts only depend on parseMeasurement()'s output.
import { numberToUUID } from '@capacitor-community/bluetooth-le';
import type { SensorReading } from './types';

export const NAME_PREFIX = 'IVS-';
export const MEASUREMENT_SERVICE = '0000a000-6976-6973-656e-000000000000';
export const MEASUREMENT_CHAR = '0000a001-6976-6973-656e-000000000000';
// Standard Battery Service / Battery Level
export const BATTERY_SERVICE = numberToUUID(0x180f);
export const BATTERY_LEVEL_CHAR = numberToUUID(0x2a19);

/**
 * Placeholder packet (little-endian, 10 bytes):
 *   u16 pm10 µg/m³ · u16 pm2.5 µg/m³ · u16 co ppm×10 · i16 temp °C×10 · u16 humidity %×10
 */
export function parseMeasurement(v: DataView, now = Date.now()): SensorReading | null {
  if (v.byteLength < 4) return null;
  const r: SensorReading = { ts: now, pm10: v.getUint16(0, true), pm25: v.getUint16(2, true) };
  if (v.byteLength >= 6) r.co = v.getUint16(4, true) / 10;
  if (v.byteLength >= 8) r.temp = v.getInt16(6, true) / 10;
  if (v.byteLength >= 10) r.humidity = v.getUint16(8, true) / 10;
  return r;
}
