// Exposure math. Pure functions so they can be tested without a database.
//
// - 상태(level): 현재 농도 / 구역 권고치.  ≥ 100% 위험, ≥ 80% 주의, 그 외 안전.
// - 누적 노출량(%): 8시간 시간가중평균(TWA)을 권고치로 나눈 값.
//     Σ (pm10_i / limit_i) · dt_i  /  8h  × 100
//   각 측정값은 다음 측정까지 유지되는 것으로 보고, 센서가 끊긴 구간(5분 초과 공백)은 빼고 계산한다.

export type Level = 'safe' | 'caution' | 'danger';

export const CAUTION_RATIO = 0.8;
export const MAX_GAP_MS = 5 * 60_000;
export const SHIFT_MS = 8 * 60 * 60_000;

export function levelOf(value: number, limit: number): Level {
  const r = value / limit;
  if (r >= 1) return 'danger';
  if (r >= CAUTION_RATIO) return 'caution';
  return 'safe';
}

const RANK: Record<Level, number> = { safe: 0, caution: 1, danger: 2 };
export const worse = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);
export const isEscalation = (from: Level, to: Level) => RANK[to] > RANK[from];

export interface Sample {
  ts: number; // epoch ms
  pm10: number;
  limit: number;
  zoneId: number | null;
}

/** Each sample paired with how long it counts for (ms). Samples must be sorted by ts. */
export function weighted(samples: Sample[], now: number): { s: Sample; dt: number }[] {
  return samples.map((s, i) => {
    const next = i + 1 < samples.length ? samples[i + 1].ts : now;
    const dt = Math.max(0, Math.min(next - s.ts, MAX_GAP_MS));
    return { s, dt };
  });
}

export function exposurePercent(samples: Sample[], now: number): number {
  let sum = 0;
  for (const { s, dt } of weighted(samples, now)) sum += (s.pm10 / s.limit) * dt;
  return (sum / SHIFT_MS) * 100;
}

export function timeWeightedAverage(samples: Sample[], now: number): number | null {
  let sum = 0;
  let total = 0;
  for (const { s, dt } of weighted(samples, now)) {
    sum += s.pm10 * dt;
    total += dt;
  }
  return total > 0 ? sum / total : null;
}

export function measuredMs(samples: Sample[], now: number): number {
  return weighted(samples, now).reduce((a, { dt }) => a + dt, 0);
}

/** Time-weighted averages per fixed bucket from `start` until `now`. */
export function buckets(samples: Sample[], start: number, now: number, sizeMs = 30 * 60_000) {
  const n = Math.max(1, Math.ceil((now - start) / sizeMs));
  const acc = Array.from({ length: n }, () => ({ sum: 0, dt: 0 }));
  for (const { s, dt } of weighted(samples, now)) {
    // split a sample's duration across bucket boundaries
    let t = s.ts;
    let left = dt;
    while (left > 0) {
      const i = Math.floor((t - start) / sizeMs);
      const end = start + (i + 1) * sizeMs;
      const part = Math.min(left, end - t);
      if (i >= 0 && i < n) {
        acc[i].sum += s.pm10 * part;
        acc[i].dt += part;
      }
      t += part;
      left -= part;
    }
  }
  return acc.map((b, i) => ({ start: start + i * sizeMs, avg: b.dt > 0 ? b.sum / b.dt : null }));
}

export function zoneDurations(samples: Sample[], now: number): Map<number | null, number> {
  const m = new Map<number | null, number>();
  for (const { s, dt } of weighted(samples, now)) m.set(s.zoneId, (m.get(s.zoneId) ?? 0) + dt);
  return m;
}

export function peak(samples: Sample[]): Sample | null {
  return samples.reduce<Sample | null>((best, s) => (!best || s.pm10 > best.pm10 ? s : best), null);
}

// ---- site-local calendar (Korea: fixed +09:00) -------------------------------

export function dayStart(epochMs: number, tzOffsetMin: number): number {
  const off = tzOffsetMin * 60_000;
  return Math.floor((epochMs + off) / 86_400_000) * 86_400_000 - off;
}

/** 'HH:MM:SS' shift time on the local day containing `epochMs` → epoch ms. */
export function atLocalTime(epochMs: number, hhmmss: string, tzOffsetMin: number): number {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return dayStart(epochMs, tzOffsetMin) + ((h * 60 + m) * 60 + (s || 0)) * 1000;
}

export function localParts(epochMs: number, tzOffsetMin: number) {
  const d = new Date(epochMs + tzOffsetMin * 60_000);
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(), // 0 = Sunday
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
  };
}

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

export function hhmm(epochMs: number, tzOffsetMin: number): string {
  const p = localParts(epochMs, tzOffsetMin);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}
