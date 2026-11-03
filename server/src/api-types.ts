// API contract. The app imports these types directly (type-only), so a change
// here is checked on both sides by `tsc`.

export type Level = 'safe' | 'caution' | 'danger';

export interface ApiError {
  error: string; // machine code, e.g. 'invalid_code'
  message: string; // Korean, safe to show
}

// ---- auth: phone number + one-time invite code from a manager ----
export interface LoginRequest {
  phone: string;
  code: string; // 6 digits
}
export interface LoginResponse {
  token: string;
  me: Me;
}

// ---- admin (managers / admin dashboard) ----
export interface InviteRequest {
  workerId?: number;
  phone?: string;
  ttlHours?: number; // default 72
}
export interface InviteResponse {
  code: string;
  expiresAt: string;
  worker: { id: number; name: string; phone: string };
}

// ---- me ----
export interface SensorInfo {
  id: string;
  battery: number | null;
  firmware: string | null;
  calibratedOn: string | null; // YYYY-MM-DD
  lastSeenAt: string | null;
  /** Shared test sensor (IVS-TEST-*): anyone can pick it; the app feeds it simulated readings. */
  test?: boolean;
}

/** Test sensors listed on the login sensor screen without Bluetooth. */
export interface TestSensor {
  id: string;
  battery: number | null;
}

export interface Me {
  id: number;
  employeeNo: string;
  name: string;
  company: string | null;
  team: string | null;
  site: { id: number; name: string; controlRoomPhone: string | null };
  zones: string[]; // 배정 구역 이름
  shift: { name: string | null; start: string | null; end: string | null }; // 'HH:MM'
  manager: { name: string; title: string; phone: string } | null;
  sensor: SensorInfo | null;
  /** Demo / review account: the app uses the simulated sensor. */
  demo: boolean;
  /** Site rule "주의: 작업자 앱 알림" (admin settings). Danger alerts can't be turned off. */
  cautionAlerts?: boolean;
}

export interface Status {
  zone: { code: string; name: string; spot: string | null; limit: number } | null;
  now: { pm10: number; level: Level; ts: string } | null; // null = 최근 2분간 측정 없음
  exposure: { percent: number; level: Level };
  shift: { minutesLeft: number | null };
  refuge: { name: string; distanceM: number | null } | null;
  sensor: { id: string; battery: number | null; lastSeenAt: string | null } | null;
}

export interface Exposure {
  dateLabel: string; // '11월 2일 월요일'
  shiftName: string | null;
  percent: number;
  level: Level;
  average: number | null; // µg/m³
  limit: number;
  workedMinutes: number;
  minutesLeft: number | null;
  peak: { value: number; time: string; zone: string | null } | null;
  alerts: { total: number; caution: number; danger: number };
  series: { time: string; avg: number | null }[]; // 30분 단위
  zones: { name: string; minutes: number }[];
  week: { day: string; percent: number | null; today: boolean }[];
}

export interface LogEvent {
  id: number;
  time: string; // 'HH:MM'
  type: 'alert' | 'move' | 'sensor' | 'sos' | 'request';
  level: 'caution' | 'danger' | null;
  title: string;
  detail: string | null;
}
export interface LogDay {
  today: LogEvent[];
  yesterday: { percent: number | null; level: Level; alerts: number; count: number };
}

// ---- site ----
export interface TeamMember {
  id: number;
  name: string;
  initial: string;
  zone: string | null;
  distanceM: number | null;
  x: number | null;
  y: number | null;
  level: Level;
}
export interface Site {
  name: string;
  working: number;
  cautionZone: string | null;
  pm10: number | null;
  me: { x: number | null; y: number | null };
  team: TeamMember[];
  notices: { id: number; title: string; detail: string | null }[];
}

// ---- readings ----
export interface ReadingIn {
  ts: string; // ISO
  pm10: number;
  pm25?: number;
  co?: number;
  temp?: number;
  humidity?: number;
}
export interface ReadingsRequest {
  sensorId: string;
  battery?: number;
  readings: ReadingIn[];
}
export interface ReadingsResponse {
  accepted: number;
  level: Level;
}

export interface SensorLive {
  sensor: SensorInfo | null;
  latest: { ts: string; pm10: number; pm25: number | null; co: number | null; temp: number | null; humidity: number | null } | null;
  history: { ts: string; pm10: number; pm25: number | null; co: number | null }[]; // 최근 30분
  limits: { pm10: number; pm25: number; co: number };
}

// ---- sos ----
export interface SosRequest {
  lat?: number;
  lng?: number;
  accuracy?: number;
}
export interface SosResponse {
  id: number;
  createdAt: string;
  time: string; // 'HH:MM'
  zone: string | null;
  spot: string | null;
  pm10: number | null;
  notified: string[]; // ['반장', '관제실']
}
