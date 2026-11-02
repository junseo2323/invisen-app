// In-browser stand-in for the invisen API, used only by the demo build (VITE_DEMO=1):
// the whole app runs with no server, on the design's sample data plus the simulated sensor.
import type * as T from '../../server/src/api-types';
import { app } from '../store';
import { ApiError } from '../errors';
import { scenario } from '../sensor/sim';

const MIN = 60_000;
const ZONE = { code: '3', name: '3구역', spot: 'C-12', limit: 100 };
// the design's 12번 artboard: caution happens in 5구역 B-04 with 82% cumulative
const zoneNow = () => (scenario() === 'caution' ? { code: '5', name: '5구역', spot: 'B-04', limit: 100 } : ZONE);
const cumulative = () => (scenario() === 'safe' ? 39 : 82);
const PROFILE = [20, 26, 30, 34, 41, 47, 55, 62, 88, 112, 15, 14, 33, 36, 38];
const wait = <V>(v: V, ms = 250) => new Promise<V>((r) => setTimeout(() => r(v), ms));
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const levelOf = (v: number, l: number): T.Level => (v / l >= 1 ? 'danger' : v / l >= 0.8 ? 'caution' : 'safe');

const sensor: T.SensorInfo = { id: 'IVS-P10-0142', battery: 92, firmware: 'v2.1.4', calibratedOn: '2026-10-12', lastSeenAt: null };
const me: T.Me = {
  id: 1,
  employeeNo: 'W-03-0218',
  name: '김현수',
  company: '협력사 A',
  team: '수하물 처리팀',
  site: { id: 1, name: '인천공항 T1 BHS', controlRoomPhone: null },
  zones: ['3구역', '5구역'],
  shift: { name: '주간 A조', start: '07:00', end: '15:00' },
  manager: { name: '박정민', title: '반장', phone: '' },
  sensor: null,
};

const events: T.LogEvent[] = [
  { id: 8, time: '14:05', type: 'move', level: null, title: '3구역으로 이동', detail: '휴게실 → 3구역' },
  { id: 7, time: '12:58', type: 'sensor', level: null, title: '센서 다시 연결', detail: '42초 동안 끊겼어요' },
  { id: 6, time: '12:02', type: 'move', level: null, title: '휴게실로 이동', detail: '5구역 → 휴게실' },
  { id: 5, time: '11:31', type: 'alert', level: null, title: '위험 알림 확인', detail: '5구역을 벗어났어요' },
  { id: 4, time: '11:24', type: 'alert', level: 'danger', title: '5구역 PM10 112 µg/m³', detail: '권고치 112% · 관리자에게 전달됐어요' },
  { id: 3, time: '11:02', type: 'alert', level: 'caution', title: '5구역 PM10 88 µg/m³', detail: '권고치 88% · 마스크를 써주세요' },
  { id: 2, time: '09:48', type: 'move', level: null, title: '5구역으로 이동', detail: '3구역 → 5구역' },
  { id: 1, time: '07:02', type: 'sensor', level: null, title: '측정 시작', detail: 'IVS-P10-0142' },
];
let nextEvent = 9;
const log = (e: Omit<T.LogEvent, 'id' | 'time'>) => events.unshift({ ...e, id: nextEvent++, time: hhmm(new Date()) });

function live() {
  const l = app.state.live;
  return l && Date.now() - l.ts < 2 * MIN ? l : null;
}

export const demoApi = {
  async requestOtp(_phone: string): Promise<T.OtpResponse> {
    return wait({ ttlSec: 180, resendSec: 30 });
  },
  async verify(phone: string, code: string): Promise<T.VerifyResponse> {
    if (code !== '000000') throw new ApiError(400, 'invalid_code', '인증번호가 맞지 않아요. 데모에서는 000000 이에요.');
    void phone;
    return wait({ token: 'demo', me });
  },
  async logout() {
    me.sensor = null;
  },
  async me() {
    return wait(me, 50);
  },
  async status(): Promise<T.Status> {
    const l = live();
    return wait(
      {
        zone: zoneNow(),
        now: l ? { pm10: Math.round(l.pm10), level: l.level, ts: new Date(l.ts).toISOString() } : null,
        exposure: { percent: cumulative(), level: levelOf(cumulative(), 100) },
        shift: { minutesLeft: 28 },
        refuge: { name: '휴게실 B', distanceM: 40 },
        sensor: me.sensor ? { id: me.sensor.id, battery: app.state.battery, lastSeenAt: null } : null,
      },
      50,
    );
  },
  async exposure(): Promise<T.Exposure> {
    const now = new Date();
    const l = live();
    const series = PROFILE.map((v, i) => ({ time: `${String(7 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, avg: i === PROFILE.length - 1 && l ? Math.round(l.pm10) : v }));
    return wait({
      dateLabel: new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(now),
      shiftName: '주간 A조',
      percent: 39,
      level: 'safe',
      average: 44,
      limit: 100,
      workedMinutes: 452,
      minutesLeft: 28,
      peak: { value: 112, time: '11:24', zone: '5구역' },
      alerts: { total: 2, caution: 1, danger: 1 },
      series,
      zones: [
        { name: '3구역', minutes: 250 },
        { name: '5구역', minutes: 110 },
        { name: '휴게실 B', minutes: 62 },
      ],
      week: [
        { day: '화', percent: 36, today: false },
        { day: '수', percent: 44, today: false },
        { day: '목', percent: 81, today: false },
        { day: '금', percent: 39, today: false },
        { day: '토', percent: null, today: false },
        { day: '일', percent: 38, today: false },
        { day: '오늘', percent: 39, today: true },
      ],
    });
  },
  async events(): Promise<T.LogDay> {
    return wait({ today: [...events], yesterday: { percent: 38, level: 'safe', alerts: 0, count: 6 } });
  },
  async site(): Promise<T.Site> {
    const team: [string, string, number, number, number, T.Level][] = [
      ['이도윤', '3구역', 47, 19.9, 49.6, 'safe'],
      ['최서연', '3구역', 93, 11.9, 63.1, 'safe'],
      ['오세린', '4구역', 163, 44.1, 39.8, 'safe'],
      ['한지민', '휴게실 B', 237, 57.0, 72.4, 'safe'],
      ['정우진', '5구역', 299, 70.0, 52.1, 'caution'],
      ['박하늘', '5구역', 369, 79.3, 41.6, 'caution'],
      ['김태오', '5구역', 405, 86.5, 58.5, 'caution'],
    ];
    return wait({
      name: '인천공항 제1여객터미널',
      working: 24,
      cautionZone: '5구역',
      pm10: 41,
      me: { x: 24.3, y: 55.7 },
      team: team.map(([name, zone, distanceM, x, y, level], i) => ({ id: i + 2, name, initial: name[0], zone, distanceM, x, y, level })),
      notices: [{ id: 1, title: '5구역 집진기를 점검하고 있어요', detail: '14:00–16:00 · 관제실' }],
    });
  },
  async sensorLive(): Promise<T.SensorLive> {
    return wait({ sensor: me.sensor, latest: null, history: [], limits: { pm10: 100, pm25: 50, co: 30 } });
  },
  async pairSensor(sensorId: string): Promise<T.SensorInfo> {
    me.sensor = { ...sensor, id: sensorId };
    log({ type: 'sensor', level: null, title: '센서 연결', detail: sensorId });
    return wait(me.sensor, 400);
  },
  async pushToken(_token: string) {},
  async postReadings(body: T.ReadingsRequest): Promise<T.ReadingsResponse> {
    const last = body.readings.at(-1);
    return { accepted: body.readings.length, level: last ? levelOf(last.pm10, ZONE.limit) : 'safe' };
  },
  async sos(_body: T.SosRequest): Promise<T.SosResponse> {
    log({ type: 'sos', level: 'danger', title: 'SOS 호출', detail: '관제실과 반장님께 보냈어요' });
    const now = new Date();
    return wait({ id: 1, createdAt: now.toISOString(), time: hhmm(now), zone: ZONE.name, spot: ZONE.spot, pm10: live() ? Math.round(live()!.pm10) : null, notified: ['반장', '관제실'] }, 600);
  },
  async cancelSos(_id: number) {
    log({ type: 'sos', level: null, title: 'SOS 취소', detail: '호출을 취소했어요' });
  },
  async requestShift() {
    log({ type: 'request', level: null, title: '교대 요청', detail: '박정민 반장에게 보냈어요' });
    return wait({ notified: ['박정민 반장'] }, 400);
  },
  async ackAlert() {
    log({ type: 'alert', level: null, title: '위험 알림 확인', detail: '3구역에서 대피 안내를 확인했어요' });
  },
};
