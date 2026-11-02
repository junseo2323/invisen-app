// Real sensor over Bluetooth LE (@capacitor-community/bluetooth-le).
import { BleClient } from '@capacitor-community/bluetooth-le';
import type { SensorDriver } from './types';
import { BATTERY_LEVEL_CHAR, BATTERY_SERVICE, MEASUREMENT_CHAR, MEASUREMENT_SERVICE, NAME_PREFIX, parseMeasurement } from './protocol';

let initialized = false;
let connected: string | null = null;
let scanTimer: number | undefined;
let batteryTimer: number | undefined;

export const bleDriver: SensorDriver = {
  kind: 'ble',

  async ensureReady() {
    try {
      if (!initialized) {
        await BleClient.initialize(); // iOS shows the Bluetooth permission prompt here
        initialized = true;
      }
      return await BleClient.isEnabled();
    } catch {
      return false;
    }
  },

  async scan(onFound, ms = 8000) {
    if (!(await this.ensureReady())) throw new Error('bluetooth_unavailable');
    await this.stopScan();
    await BleClient.requestLEScan({ namePrefix: NAME_PREFIX, allowDuplicates: false }, (r) => {
      const id = r.localName ?? r.device.name;
      if (!id?.startsWith(NAME_PREFIX)) return;
      onFound({ deviceId: r.device.deviceId, id, rssi: r.rssi ?? null, battery: null });
    });
    await new Promise<void>((resolve) => {
      scanTimer = window.setTimeout(resolve, ms);
    });
    await this.stopScan();
  },

  async stopScan() {
    clearTimeout(scanTimer);
    try {
      await BleClient.stopLEScan();
    } catch {
      /* not scanning */
    }
  },

  async connect(deviceId, h) {
    if (!(await this.ensureReady())) throw new Error('bluetooth_unavailable');
    if (connected && connected !== deviceId) await this.disconnect();
    await BleClient.connect(
      deviceId,
      () => {
        connected = null;
        clearInterval(batteryTimer);
        h.onDisconnect();
      },
      { timeout: 15_000 },
    );
    connected = deviceId;
    await BleClient.startNotifications(deviceId, MEASUREMENT_SERVICE, MEASUREMENT_CHAR, (v) => {
      const r = parseMeasurement(v);
      if (r) h.onReading(r);
    });
    const readBattery = async () => {
      try {
        const v = await BleClient.read(deviceId, BATTERY_SERVICE, BATTERY_LEVEL_CHAR);
        h.onBattery(v.getUint8(0));
      } catch {
        /* battery service optional */
      }
    };
    await readBattery();
    clearInterval(batteryTimer);
    batteryTimer = window.setInterval(readBattery, 5 * 60_000);
  },

  async disconnect() {
    clearInterval(batteryTimer);
    if (!connected) return;
    const id = connected;
    connected = null;
    try {
      await BleClient.disconnect(id);
    } catch {
      /* already gone */
    }
  },
};
