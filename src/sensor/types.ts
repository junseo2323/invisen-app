export interface FoundSensor {
  deviceId: string;
  /** Sensor serial, e.g. 'IVS-P10-0142' (the advertised name). */
  id: string;
  rssi: number | null;
  battery: number | null;
}

export interface SensorReading {
  ts: number; // epoch ms
  pm10: number;
  pm25?: number;
  co?: number;
  temp?: number;
  humidity?: number;
}

export interface SensorDriver {
  readonly kind: 'ble' | 'sim';
  /** Ask for Bluetooth (permission + powered on). false = unavailable/denied. */
  ensureReady(): Promise<boolean>;
  scan(onFound: (s: FoundSensor) => void, ms?: number): Promise<void>;
  stopScan(): Promise<void>;
  connect(
    deviceId: string,
    handlers: { onReading: (r: SensorReading) => void; onBattery: (pct: number) => void; onDisconnect: () => void },
  ): Promise<void>;
  disconnect(): Promise<void>;
}
