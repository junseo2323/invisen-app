// Admin API client (/api/admin/*). The token lives in localStorage ("로그인 유지") or
// sessionStorage (this tab only).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const KEY = 'invisen-admin-token';
const BASE = '/api/admin';

let token: string | null = (() => {
  try {
    return localStorage.getItem(KEY) ?? sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
})();
let onUnauthorized: () => void = () => {};

export const hasToken = () => !!token;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export function setToken(next: string | null, remember = true) {
  token = next;
  try {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    if (next) (remember ? localStorage : sessionStorage).setItem(KEY, next);
  } catch {
    /* private mode: keep it in memory */
  }
}

async function call<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', '서버에 연결할 수 없어요. 네트워크를 확인해 주세요.');
  }
  if (res.status === 401 && token) {
    setToken(null);
    onUnauthorized();
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? 'error', e.message ?? '요청을 처리하지 못했어요.');
  }
  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- response shapes ----------------------------------------------------------------
export type Role = 'owner' | 'admin' | 'viewer';
export type WorkerState = 'danger' | 'caution' | 'safe' | 'off';
export interface Admin { id: number; username?: string; name: string; title: string | null; role: Role; mustChangePassword: boolean }
export interface SiteCard { id: number; name: string; facility: string | null; zones: string | null; status: 'active' | 'preparing'; working: number; sensorsOnline: number; sensorsTotal: number; caution: number; danger: number }
export interface AlertItem {
  id: number; type: 'caution' | 'danger' | 'sos' | 'sensor' | 'advice' | 'notice'; cat: string; advice: boolean;
  status: 'open' | 'acked' | 'resolved' | 'auto' | 'info'; statusLabel: string; pending: boolean; time: string;
  title: string; sub: string | null; rec: string | null; metrics: [string, string][]; people: { id: number; name: string }[];
  timeline: [string, string][]; primary: { label: string; href: string } | null;
}
export interface Overview {
  siteName: string; facility: string | null; dateLabel: string; time: string;
  kpis: { working: number; shiftLabel: string; caution: number; cautionNote: string; danger: number; dangerNote: string; avgPm10: number | null; limit: number; sensorsOnline: number; sensorsTotal: number; sensorsNote: string };
  zones: { id: number; name: string; avg: number | null; workers: number; level: 'safe' | 'caution' | 'danger' }[];
  restCount: number;
  workers: { id: number; name: string; employeeNo: string; zone: string | null; x: number | null; y: number | null; pm10: number | null; cum: number; state: WorkerState; battery: number | null }[];
  alerts: AlertItem[];
}
export interface WorkerRow { id: number; name: string; employeeNo: string; phone: string; org: string; zone: string | null; shift: string | null; conn: 'on' | 'off' | 'pending'; inviteExpiresAt: string | null; sensor: string | null }
export interface FormOptions { zones: { id: number; name: string }[]; orgs: string[]; shifts: { name: string; start: string; end: string }[] }
export interface Invite { code: string; expiresAt: string }
export interface WorkerDetail {
  id: number; name: string; initial: string; employeeNo: string; phone: string; org: string; shift: string | null; shiftTime: string | null;
  state: WorkerState; pm10: number | null; limit: number; cum: number; zone: string | null; spot: string | null; zoneSinceMin: number | null;
  sensor: { id: string; connected: boolean; battery: number | null; lastSeen: string | null } | null;
  bars: { time: string; avg: number | null }[];
  segments: { zone: string; from: string; to: string; minutes: number }[];
  events: { time: string; type: string; level: string | null; title: string; detail: string | null }[];
  week: { day: string; percent: number | null; today: boolean }[];
  weekNote: string; advice: string | null;
}
export interface AlertList { day: 'today' | 'yesterday'; dateLabel: string; list: AlertItem[]; yesterday: { n: number; open: number }; pending: number }
export interface Report {
  range: string; period: 'day' | 'week' | 'month'; end: string | null; prevLabel: string;
  summary: { avg: number | null; delta: number | null; caution: number; cautionNote: string; danger: number; dangerNote: string; handled: number; total: number; avgResponseSec: number | null };
  columns: { label: string; today: boolean }[];
  heat: { zone: string; cells: (number | null)[] }[];
  alertBars: { label: string; today: boolean; caution: number; danger: number }[];
  people: { id: number; name: string; zone: string; avg: number; max: number; cautionDays: number; danger: number; rec: string }[];
}
export interface SensorRow { id: string; maker: string; items: string; who: string; workerId: number | null; battery: number | null; last: string; calibrated: string; calDue: boolean; zone: string | null; kind: 'on' | 'off' | 'free' }
export interface SensorList { counts: { total: number; on: number; off: number; free: number; cal: number; low: number }; sensors: SensorRow[] }
export type Rules = Record<'cApp' | 'cAdmin' | 'dEvac' | 'advice' | 'sensor', boolean>;
export interface Settings {
  site: { name: string; facility: string; address: string; shifts: { name: string; start: string; end: string }[]; zones: number; rest: number };
  limits: { pm10: number; pm25: number; co: number; caution: number; danger: number };
  rules: Rules;
  members: { id: number; username: string; name: string; title: string | null; role: Role; active: boolean; me: boolean }[];
  myRole: Role;
  integrations: { app: { n: number; online: number }; push: boolean; webhook: boolean };
}

const enc = encodeURIComponent;

export const api = {
  login: (username: string, password: string, remember: boolean) =>
    call<{ token: string; admin: Admin }>('POST', '/auth/login', { username, password, remember }),
  logout: () => call<void>('POST', '/auth/logout'),
  me: () => call<Admin>('GET', '/me'),
  changePassword: (current: string, next: string) => call<void>('POST', '/me/password', { current, next }),

  sites: () => call<SiteCard[]>('GET', '/sites'),
  overview: (site: number) => call<Overview>('GET', `/sites/${site}/overview`),
  pendingCount: (site: number) => call<{ n: number }>('GET', `/sites/${site}/alerts/pending-count`),

  workers: (site: number) => call<WorkerRow[]>('GET', `/sites/${site}/workers`),
  formOptions: (site: number) => call<FormOptions>('GET', `/sites/${site}/form-options`),
  addWorker: (site: number, body: { name: string; employeeNo: string; phone: string; org?: string; zoneIds: number[]; shift?: string }) =>
    call<{ worker: { id: number; name: string; employeeNo: string }; invite: Invite }>('POST', `/sites/${site}/workers`, body),
  invite: (worker: number) => call<Invite>('POST', `/workers/${worker}/invite`),
  setWorkerActive: (worker: number, active: boolean) => call<{ id: number; active: boolean }>('PATCH', `/workers/${worker}`, { active }),
  worker: (id: number) => call<WorkerDetail>('GET', `/workers/${id}`),
  shiftOrder: (id: number) => call<{ sent: boolean; pushed: number }>('POST', `/workers/${id}/shift-order`),
  readingsCsv: (id: number, days: number) => call<Response>('GET', `/workers/${id}/readings.csv?days=${days}`, undefined, true),

  alerts: (site: number, day: 'today' | 'yesterday') => call<AlertList>('GET', `/sites/${site}/alerts?day=${day}`),
  ack: (id: number) => call<{ id: number; acked: boolean }>('POST', `/alerts/${id}/ack`),
  resolve: (id: number) => call<{ id: number; resolved: boolean }>('POST', `/alerts/${id}/resolve`),

  report: (site: number, period: 'day' | 'week' | 'month', end?: string) =>
    call<Report>('GET', `/sites/${site}/reports?period=${period}${end ? `&end=${enc(end)}` : ''}`),

  sensors: (site: number) => call<SensorList>('GET', `/sites/${site}/sensors`),
  addSensor: (site: number, body: { id: string; maker?: string; model?: string; items?: string; calibratedOn?: string }) =>
    call<{ id: string }>('POST', `/sites/${site}/sensors`, body),

  settings: (site: number) => call<Settings>('GET', `/sites/${site}/settings`),
  saveSettings: (site: number, body: { site?: { name: string; facility: string; address: string }; limits?: { pm10: number; pm25: number; co: number }; rules?: Partial<Rules> }) =>
    call<{ ok: true }>('PUT', `/sites/${site}/settings`, body),
  addAdmin: (body: { username: string; name: string; title?: string; role: 'admin' | 'viewer'; password: string }) => call<{ id: number }>('POST', '/admins', body),
  patchAdmin: (id: number, body: { active?: boolean; password?: string }) => call<{ id: number }>('PATCH', `/admins/${id}`, body),
};
