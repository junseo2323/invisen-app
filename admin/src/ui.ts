// Shared look & small DOM helpers for the dashboard screens.
import { ApiError } from './api';

export const C = {
  ink: '#e3e7eb',
  muted: '#a9b1bb',
  dim: '#5f6975',
  faint: '#848e9a',
  seg: '#2c333b',
  seg2: '#3f4852',
  panel: '#13171c',
  well: '#070a0d',
  chip: '#1c2127',
  signal: '#2bd8f0',
  signalSoft: '#0d2e35',
  safe: '#34c77b',
  caution: '#ffbe1a',
  danger: '#ff5a4a',
};
export const SOFT = { safe: '#0e2a1c', caution: '#2e2306', danger: '#35110e', off: '#1c2127' } as const;
export type Lvl = 'safe' | 'caution' | 'danger' | 'off';
export const WORD: Record<Lvl, string> = { safe: '안전', caution: '주의', danger: '위험', off: '연결 끊김' };
export const levelColor = (l: Lvl) => (l === 'off' ? C.muted : C[l]);

/** Level badge: soft background, text colour, and the three-step scale. */
export function badge(l: Lvl, off = C.seg) {
  return {
    soft: SOFT[l],
    color: levelColor(l),
    s1: l === 'safe' ? C.safe : off,
    s2: l === 'caution' ? C.caution : off,
    s3: l === 'danger' ? C.danger : off,
    scaleDisplay: l === 'off' ? 'none' : 'flex',
    word: WORD[l],
  };
}

/** Level of a value against a limit: ≥100% danger, ≥80% caution. */
export const levelOf = (v: number | null, limit: number): Lvl => (v == null ? 'off' : v >= limit ? 'danger' : v >= limit * 0.8 ? 'caution' : 'safe');
export const pctColor = (p: number) => (p >= 100 ? C.danger : p >= 80 ? C.caution : C.muted);

/** A segmented-control button as the design draws it. */
export const seg = (label: string, on: boolean, pick: () => void) => ({
  label,
  on,
  pick,
  bg: on ? C.seg : 'transparent',
  fg: on ? C.ink : C.muted,
  fw: on ? 700 : 400,
});

/** A toggle chip (multi/single select in forms). */
export const chip = (label: string, on: boolean, pick: () => void) => ({
  label,
  on,
  pick,
  bd: on ? C.signal : C.seg2,
  bg: on ? C.signalSoft : 'transparent',
  fg: on ? C.ink : C.muted,
  fw: on ? 700 : 400,
});

export const errText = (e: unknown) => (e instanceof ApiError ? e.message : '문제가 생겼어요. 다시 시도해 주세요.');

// ---- toast ----------------------------------------------------------------------------
let toastTimer = 0;
export function toast(text: string, ms = 2800) {
  let el = document.getElementById('admin-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

// ---- files ----------------------------------------------------------------------------
export async function download(res: Response, filename: string) {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http:// (no secure context): fall back to a hidden textarea
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

/** Random temporary password: 10 characters without look-alikes (0/O, 1/l/I). */
export function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(10);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
export const inputValue = (ev: Event) => (ev.target as HTMLInputElement).value;
