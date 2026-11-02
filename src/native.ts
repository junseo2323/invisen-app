// Native bridges. Inside the iOS app these go through Capacitor plugins; in the
// browser they fall back to web APIs (or no-ops) so the same code runs in both.
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { Geolocation } from '@capacitor/geolocation';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';

export const isNative = Capacitor.isNativePlatform();

// ---- haptics -----------------------------------------------------------------
let patternTimers: number[] = [];
let webVibrating = false;

export const haptics = {
  tick() {
    if (isNative) void Haptics.impact({ style: ImpactStyle.Medium });
    else navigator.vibrate?.(30);
  },
  warn() {
    if (isNative) void Haptics.notification({ type: NotificationType.Warning });
    else navigator.vibrate?.([200, 100, 200]);
  },
  /** Alternating on/off durations in ms, like navigator.vibrate. */
  pattern(ms: number[]) {
    this.stop();
    if (!isNative) {
      webVibrating = !!navigator.vibrate?.(ms);
      return;
    }
    void Haptics.notification({ type: NotificationType.Error });
    let t = 0;
    ms.forEach((d, i) => {
      if (i % 2 === 0) patternTimers.push(window.setTimeout(() => void Haptics.vibrate({ duration: d }), t));
      t += d;
    });
  },
  stop() {
    patternTimers.forEach(clearTimeout);
    patternTimers = [];
    if (!isNative && webVibrating) {
      navigator.vibrate?.(0);
      webVibrating = false;
    }
  },
};

// ---- app chrome & lifecycle ----------------------------------------------------
export async function setupNativeChrome() {
  if (!isNative) return;
  try {
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch {
    /* status bar plugin unavailable */
  }
}

let foreground = true;
export const isForeground = () => foreground;

export function onAppState(fn: (active: boolean) => void) {
  if (isNative) {
    void App.addListener('appStateChange', ({ isActive }) => {
      foreground = isActive;
      fn(isActive);
    });
  } else {
    document.addEventListener('visibilitychange', () => {
      foreground = document.visibilityState === 'visible';
      fn(foreground);
    });
  }
}

// ---- permissions -------------------------------------------------------------
export type Perm = 'granted' | 'denied' | 'prompt';

export async function notificationPermission(): Promise<Perm> {
  if (!isNative) return 'Notification' in window ? (Notification.permission === 'default' ? 'prompt' : Notification.permission) : 'denied';
  const p = await LocalNotifications.checkPermissions();
  return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'prompt';
}

export async function requestNotifications(): Promise<Perm> {
  if (!isNative) {
    if (!('Notification' in window)) return 'denied';
    const r = await Notification.requestPermission();
    return r === 'default' ? 'prompt' : r;
  }
  const p = await LocalNotifications.requestPermissions();
  return p.display === 'granted' ? 'granted' : 'denied';
}

export async function locationPermission(): Promise<Perm> {
  try {
    if (!isNative) {
      const s = await navigator.permissions?.query({ name: 'geolocation' });
      return s ? (s.state as Perm) : 'prompt';
    }
    const p = await Geolocation.checkPermissions();
    return p.location === 'granted' ? 'granted' : p.location === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'prompt';
  }
}

export async function requestLocation(): Promise<Perm> {
  try {
    if (!isNative) {
      await getPosition(8000);
      return locationPermission();
    }
    const p = await Geolocation.requestPermissions({ permissions: ['location'] });
    return p.location === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

// ---- location (SOS only) -------------------------------------------------------
export async function getPosition(timeout = 5000): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  try {
    const p = isNative
      ? await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout, maximumAge: 30_000 })
      : await new Promise<GeolocationPosition>((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout, maximumAge: 30_000 }),
        );
    return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
  } catch {
    return null;
  }
}

// ---- notifications -------------------------------------------------------------
let notifId = 1;
let routeHandler: (route: string) => void = () => {};
export const onNotificationRoute = (fn: (route: string) => void) => (routeHandler = fn);

/** Local notification (shown when the app is in the background). */
export async function notifyLocal(title: string, body: string, route?: string) {
  try {
    if (isNative) {
      await LocalNotifications.schedule({
        notifications: [{ id: notifId++, title, body, extra: { route }, sound: undefined }],
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body });
      n.onclick = () => route && routeHandler(route);
    }
  } catch {
    /* notifications unavailable */
  }
}

/** Registers for APNs; `onToken` gets the device token to send to the server. */
export async function registerPush(onToken: (token: string) => void) {
  if (!isNative) return;
  try {
    const p = await PushNotifications.checkPermissions();
    if (p.receive !== 'granted') {
      const r = await PushNotifications.requestPermissions();
      if (r.receive !== 'granted') return;
    }
    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener('registration', (t) => onToken(t.value));
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const route = (a.notification.data as { route?: string } | undefined)?.route;
      if (route) routeHandler(route);
    });
    await PushNotifications.register();
  } catch {
    /* push unavailable (simulator / no entitlement) */
  }
}

export function setupNotificationTaps() {
  if (!isNative) return;
  void LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
    const route = (a.notification.extra as { route?: string } | undefined)?.route;
    if (route) routeHandler(route);
  });
}

// ---- QR (sensor serial printed on the device) ----------------------------------
export async function scanQr(): Promise<string | null> {
  if (!isNative) {
    const v = window.prompt('센서 뒷면의 번호를 입력해 주세요 (예: IVS-P10-0142)');
    return v?.trim() || null;
  }
  try {
    const r = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: '센서 뒷면의 QR 코드를 비춰주세요',
    });
    return r.ScanResult?.trim() || null;
  } catch {
    return null; // cancelled
  }
}
