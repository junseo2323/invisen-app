// Native bridges. iOS WKWebView has no navigator.vibrate, so haptics go through
// Capacitor when running inside the app and fall back to the web API otherwise.
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';

const native = Capacitor.isNativePlatform();
let patternTimers: number[] = [];
let webVibrating = false;

export const haptics = {
  tick() {
    if (native) void Haptics.impact({ style: ImpactStyle.Medium });
    else navigator.vibrate?.(30);
  },
  /** Alternating on/off durations in ms, like navigator.vibrate. */
  pattern(ms: number[]) {
    this.stop();
    if (!native) {
      webVibrating = !!navigator.vibrate?.(ms);
      return;
    }
    void Haptics.notification({ type: NotificationType.Error });
    let t = 0;
    ms.forEach((d, i) => {
      if (i % 2 === 0) {
        patternTimers.push(window.setTimeout(() => void Haptics.vibrate({ duration: d }), t));
      }
      t += d;
    });
  },
  stop() {
    patternTimers.forEach(clearTimeout);
    patternTimers = [];
    if (!native && webVibrating) {
      navigator.vibrate?.(0);
      webVibrating = false;
    }
  },
};

export async function setupNativeChrome() {
  if (!native) return;
  try {
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch {
    /* status bar plugin unavailable */
  }
}
