// Screen state for every artboard. Values come from the API (server/src/api-types.ts)
// and the live sensor stream (src/monitor.ts); markup lives in ./markup.
import { Screen } from '../dc';
import { api, ApiError, setToken } from '../api';
import { app } from '../store';
import { sensor, type FoundSensor } from '../sensor';
import { haptics, getPosition, locationPermission, notificationPermission, requestLocation, requestNotifications, scanQr, type Perm } from '../native';
import { history, reconnectSensor, refreshStatus, startMonitor, stopMonitor } from '../monitor';
import type { Exposure, Level, LogDay, SensorLive, Site as SiteData } from '../../server/src/api-types';

// ---- shared helpers ------------------------------------------------------------
type Look = Level | 'none';
const LOOK: Record<Look, { word: string; color: string; soft: string; s: [string, string, string] }> = {
  safe: { word: '안전', color: '#34c77b', soft: '#0e2a1c', s: ['#34c77b', '#2c333b', '#2c333b'] },
  caution: { word: '주의', color: '#ffbe1a', soft: '#2e2306', s: ['#3f4852', '#ffbe1a', '#3f4852'] },
  danger: { word: '위험', color: '#ff5a4a', soft: '#35110e', s: ['#3f4852', '#3f4852', '#ff5a4a'] },
  none: { word: '대기', color: '#a9b1bb', soft: '#13171c', s: ['#2c333b', '#2c333b', '#2c333b'] },
};
export const badge = (l: Look) => {
  const x = LOOK[l];
  return { word: x.word, color: x.color, soft: x.soft, s1: x.s[0], s2: x.s[1], s3: x.s[2] };
};
const RANK: Record<Look, number> = { none: -1, safe: 0, caution: 1, danger: 2 };
const worse = (a: Look, b: Look): Look => (RANK[a] >= RANK[b] ? a : b);
const levelOf = (v: number, limit: number): Level => (v / limit >= 1 ? 'danger' : v / limit >= 0.8 ? 'caution' : 'safe');

const TZ = 'Asia/Seoul';
const fmtTime = (d: Date | number, seconds = false) =>
  new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false, timeZone: TZ }).format(d);
const fmtDate = (d: Date | number) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long', timeZone: TZ }).format(d);
const go = (route: string) => (location.hash = `#${route}`);
const errText = (e: unknown) => (e instanceof ApiError ? e.message : '잠시 문제가 생겼어요. 다시 시도해 주세요.');
/** Native confirm in the app; the demo (shown where dialogs are blocked) just proceeds. */
const ask = (msg: string) => import.meta.env.VITE_DEMO === '1' || window.confirm(msg);
const tel = (n: string | null | undefined) => (n ? `tel:${n.replace(/[^\d+]/g, '')}` : '#');

/** Current PM10: the live sensor value if fresh, else the server's last reading. */
function current() {
  const { live, status } = app.state;
  const limit = status?.zone?.limit ?? 100;
  if (live && Date.now() - live.ts < 120_000) return { value: Math.round(live.pm10), level: live.level as Look, ts: live.ts, limit };
  if (status?.now) return { value: status.now.pm10, level: status.now.level as Look, ts: Date.parse(status.now.ts), limit };
  return { value: null, level: 'none' as Look, ts: null, limit };
}

function linkWord() {
  switch (app.state.link) {
    case 'connected':
      return '연결됨';
    case 'reconnecting':
      return '다시 연결하는 중';
    case 'connecting':
      return '연결하는 중';
    default:
      return '연결 안 됨';
  }
}

async function logoutLocal() {
  await stopMonitor();
  setToken(null);
  await app.persist({ token: null, onboarded: false, deviceId: null });
  app.set({ me: null, status: null, sos: null });
}

/** Screen that loads data on mount and refreshes it on an interval. */
abstract class DataScreen<D, S extends Record<string, unknown> = Record<string, unknown>> extends Screen<S & { data?: D; error?: string }> {
  private timer?: number;
  protected abstract load(): Promise<D>;
  protected every = 30_000;
  mounted() {
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), this.every);
  }
  unmount() {
    clearInterval(this.timer);
  }
  async refresh() {
    try {
      this.setState({ data: await this.load(), error: undefined } as Partial<S & { data?: D; error?: string }>);
    } catch (e) {
      this.setState({ error: errText(e) } as Partial<S & { data?: D; error?: string }>);
    }
  }
}

// ---- 02 휴대폰 번호 + 등록 코드 ----------------------------------------------------------
// The code is a one-time 6-digit invite code from the manager (admin dashboard / server).
type PhoneState = { phone: string; code: string; busy: boolean; error: string; info: string; focused: boolean };
const DEMO = import.meta.env.VITE_DEMO === '1';
const CODE_HINT = DEMO ? '데모 등록 코드는 000000 이에요.' : '반장님께 받은 6자리 등록 코드를 넣어주세요.';

export class LoginPhone extends Screen<PhoneState> {
  state: PhoneState = { phone: '', code: '', busy: false, error: '', info: CODE_HINT, focused: false };

  mounted() {
    (document.getElementById('phone') as HTMLInputElement | null)?.focus();
  }

  private validPhone = () => /^01\d{8,9}$/.test(this.state.phone.replace(/\D/g, ''));

  private async login() {
    const { phone, code } = this.state;
    if (code.length !== 6 || this.state.busy) return;
    if (!this.validPhone()) return this.setState({ error: '휴대폰 번호를 확인해 주세요.' });
    this.setState({ busy: true, error: '' });
    try {
      const r = await api.login(phone.replace(/\D/g, ''), code);
      setToken(r.token);
      await app.persist({ token: r.token, onboarded: false });
      app.set({ me: r.me });
      go('login-profile');
    } catch (e) {
      this.setState({ busy: false, code: '', error: errText(e) });
    }
  }

  renderVals() {
    const st = this.state;
    const active = st.focused && st.code.length < 6 ? st.code.length : -1;
    const disabled = st.code.length !== 6 || !this.validPhone() || st.busy;
    return {
      title1: '등록 코드를',
      title2: '입력해주세요',
      phone: st.phone,
      onPhone: (ev: Event) => this.setState({ phone: (ev.target as HTMLInputElement).value, error: '' }),
      boxes: Array.from({ length: 6 }, (_, i) => ({
        d: st.code[i] ?? '',
        border: i === active ? '2px solid #2bd8f0' : '1px solid #5f6975',
      })),
      code: st.code,
      codeDisabled: false,
      onCode: (ev: Event) => {
        const code = (ev.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
        this.setState({ code, error: '' });
        if (code.length === 6 && this.validPhone()) void this.login();
      },
      onFocus: () => this.setState({ focused: true }),
      onBlur: () => this.setState({ focused: false }),
      error: st.error,
      info: st.error ? '' : st.info,
      changed: () =>
        this.setState({ info: '현장 관리자(반장)에게 등록 코드를 요청해 주세요. 번호가 바뀌었다면 번호 변경도 함께 요청해 주세요.', error: '' }),
      verify: () => void this.login(),
      verifyDisabled: disabled,
      verifyOpacity: disabled ? 0.4 : 1,
      verifyLabel: st.busy ? '확인하는 중…' : '확인',
    };
  }
}

// ---- 03 소속 확인 --------------------------------------------------------------------
export class LoginProfile extends Screen {
  mounted() {
    if (!app.state.me) void api.me().then((me) => app.set({ me })).catch(() => {});
  }
  renderVals() {
    const me = app.state.me;
    return {
      name: me?.name ?? '',
      employeeNo: me?.employeeNo ?? '',
      org: [me?.company, me?.team].filter(Boolean).join(' · '),
      site: me?.site.name ?? '',
      zones: me?.zones.join(' · ') || '–',
      shiftName: me?.shift.name ?? '',
      shiftTime: me?.shift.start ? `${me.shift.start}–${me.shift.end}` : '',
      manager: me?.manager ? `${me.manager.name} ${me.manager.title}` : '–',
      notMe: async () => {
        if (!ask('등록된 정보가 다르면 현장 관리자에게 문의해 주세요.\n로그아웃할까요?')) return;
        await api.logout().catch(() => {});
        await logoutLocal();
        go('main');
      },
    };
  }
}

// ---- 04 센서 연결 ---------------------------------------------------------------------
type SensorPick = { found: FoundSensor[]; picked: string | null; scanning: boolean; busy: boolean; error: string; wanted: string | null };

export class LoginSensor extends Screen<SensorPick> {
  state: SensorPick = { found: [], picked: null, scanning: false, busy: false, error: '', wanted: null };

  mounted() {
    void this.scan();
  }
  unmount() {
    void sensor.stopScan();
  }

  private async scan() {
    this.setState({ found: [], scanning: true, error: '' });
    try {
      await sensor.scan((s) => {
        if (this.state.found.some((f) => f.deviceId === s.deviceId)) return;
        const found = [...this.state.found, s].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
        const mine = app.state.me?.sensor?.id;
        const picked = this.state.picked ?? found.find((f) => f.id === this.state.wanted || f.id === mine)?.id ?? found[0].id;
        this.setState({ found, picked: this.state.wanted && found.some((f) => f.id === this.state.wanted) ? this.state.wanted : picked });
      });
      this.setState({ scanning: false });
    } catch {
      this.setState({ scanning: false, error: '블루투스를 켜고 앱에 블루투스 권한을 허용해 주세요.' });
    }
  }

  private async connect() {
    const s = this.state.found.find((f) => f.id === this.state.picked);
    if (!s) return;
    this.setState({ busy: true, error: '' });
    try {
      const info = await api.pairSensor(s.id);
      await app.persist({ deviceId: s.deviceId });
      app.set({ me: app.state.me ? { ...app.state.me, sensor: info } : null, rssi: s.rssi, battery: s.battery ?? info.battery });
      await reconnectSensor();
      go('login-wear');
    } catch (e) {
      this.setState({ busy: false, error: errText(e) });
    }
  }

  renderVals() {
    const st = this.state;
    const meta = (s: FoundSensor) => {
      const near = s.rssi == null ? '' : s.rssi > -60 ? '가까워요' : s.rssi > -75 ? '조금 떨어져 있어요' : '멀어요';
      return [near, s.battery != null ? `배터리 ${s.battery}%` : ''].filter(Boolean).join(' · ') || '찾았어요';
    };
    const sensors = st.found.map((s) => {
      const selected = s.id === st.picked;
      return {
        id: s.id,
        meta: meta(s),
        selected,
        bg: selected ? '#0d2e35' : '#13171c',
        border: selected ? '#2bd8f0' : '#13171c',
        boxBg: selected ? '#2bd8f0' : 'transparent',
        boxBd: selected ? '#2bd8f0' : '#5f6975',
        checkColor: selected ? '#0b0e12' : 'transparent',
        pick: () => this.setState({ picked: s.id }),
      };
    });
    const disabled = !st.picked || st.busy;
    return {
      sensors,
      foundLabel: st.found.length ? `${st.found.length}대 찾았어요` : st.scanning ? '센서를 찾고 있어요' : '센서를 찾지 못했어요',
      scanning: st.scanning,
      rescan: () => void this.scan(),
      qr: async () => {
        const id = (await scanQr())?.toUpperCase().match(/IVS-[A-Z0-9-]+/)?.[0];
        if (!id) return;
        if (st.found.some((f) => f.id === id)) this.setState({ picked: id, wanted: id });
        else {
          this.setState({ wanted: id, picked: null });
          void this.scan();
        }
      },
      error: st.error,
      connect: () => void this.connect(),
      connectDisabled: disabled,
      connectOpacity: disabled ? 0.4 : 1,
      connectLabel: st.busy ? '연결하는 중…' : '연결하기',
    };
  }
}

// ---- 05 착용·권한 ---------------------------------------------------------------------
type Perms = { bt: Perm; notif: Perm; loc: Perm };

export class LoginWear extends Screen<Perms> {
  state: Perms = { bt: 'prompt', notif: 'prompt', loc: 'prompt' };

  mounted() {
    void this.check();
  }
  private async check() {
    this.setState({
      bt: (await sensor.ensureReady()) ? 'granted' : 'denied',
      notif: await notificationPermission(),
      loc: await locationPermission(),
    });
  }
  renderVals() {
    const row = (p: Perm, request: () => Promise<unknown>) => ({
      ok: p === 'granted',
      ask: p === 'prompt',
      denied: p === 'denied',
      request: async () => {
        await request();
        await this.check();
      },
    });
    return {
      bt: row(this.state.bt, () => sensor.ensureReady()),
      notif: row(this.state.notif, requestNotifications),
      loc: row(this.state.loc, requestLocation),
      start: async () => {
        await app.persist({ onboarded: true });
        void startMonitor();
        go('home');
      },
    };
  }
}

// ---- 06 / 12 홈 -----------------------------------------------------------------------
export class Home extends Screen<{ shiftSent?: boolean; shiftBusy?: boolean }> {
  mounted() {
    void refreshStatus();
  }
  renderVals() {
    const st = app.state.status;
    const cur = current();
    const cumPct = st?.exposure.percent ?? 0;
    const cumLevel: Look = st ? st.exposure.level : 'none';
    const variant = RANK[worse(cur.level, cumLevel)] >= RANK.caution ? 'caution' : 'safe';
    const zone = st?.zone ? [st.zone.name, st.zone.spot].filter(Boolean).join(' · ') : (app.state.me?.site.name ?? '');
    const left = st?.shift.minutesLeft;
    const cb = badge(cumLevel === 'none' ? 'safe' : cumLevel);
    const hasSensor = !!app.state.me?.sensor;
    return {
      $variant: variant,
      title: zone,
      cur: {
        ...badge(cur.level),
        value: cur.value ?? '–',
        message: { safe: '지금 공기는 괜찮아요', caution: '마스크를 꼭 써주세요', danger: '지금 바로 나와주세요', none: hasSensor ? '센서 값을 기다리고 있어요' : '센서를 연결해 주세요' }[cur.level],
      },
      cum: {
        ...cb,
        percent: cumPct,
        width: Math.min(100, cumPct),
        bar: '#e3e7eb',
        high: cumLevel === 'caution' || cumLevel === 'danger',
        message: cumLevel === 'danger' ? '오늘 권고치를 넘었어요' : cumLevel === 'caution' ? '교대할 때가 됐어요' : '오늘 누적은 괜찮아요',
      },
      shift: left != null ? { lead: '교대까지 ', value: left, tail: '분' } : { lead: '근무 시간 외', value: '', tail: '' },
      sensorLine: !hasSensor
        ? '센서를 연결해 주세요'
        : app.state.link === 'connected'
          ? `연결됨${app.state.battery != null ? ` · 배터리 ${app.state.battery}%` : ''}`
          : linkWord(),
      requestShift: async () => {
        this.setState({ shiftBusy: true });
        try {
          await api.requestShift();
          this.setState({ shiftSent: true, shiftBusy: false });
        } catch {
          this.setState({ shiftBusy: false });
        }
      },
      shiftBusy: !!this.state.shiftBusy || !!this.state.shiftSent,
      shiftLabel: this.state.shiftSent ? '반장님께 요청했어요' : this.state.shiftBusy ? '요청하는 중…' : '반장님께 교대 요청',
    };
  }
}

// ---- 13 위험 알림 ----------------------------------------------------------------------
export class AlertDanger extends Screen {
  renderVals() {
    const st = app.state.status;
    const cur = current();
    const refuge = st?.refuge;
    return {
      time: fmtTime(cur.ts ?? Date.now()),
      zone: st?.zone?.name ?? '이 구역',
      where: st?.zone ? [st.zone.name, st.zone.spot].filter(Boolean).join(' ') : '',
      value: cur.value ?? '–',
      percent: cur.value != null ? Math.round((cur.value / cur.limit) * 100) : '–',
      refuge: refuge?.name ?? '관리자 안내를 따라주세요',
      refugeDist: refuge?.distanceM != null ? `${refuge.distanceM} m` : '',
      ack: () => {
        haptics.stop();
        void api.ackAlert().catch(() => {});
        go('home');
      },
    };
  }
}

// ---- 07 현장 --------------------------------------------------------------------------
export class Site extends DataScreen<SiteData, { sel?: number | null }> {
  protected load = () => api.site();
  renderVals() {
    const d = this.state.data;
    const sel = this.state.sel ?? null;
    const team = (d?.team ?? []).map((t) => ({
      ...t,
      dist: t.distanceM != null ? `${t.distanceM} m` : '',
      caution: t.level !== 'safe',
      b: badge(t.level),
      sel: t.id === sel,
      rowBg: t.id === sel ? '#0d2e35' : 'transparent',
      pick: () => this.setState({ sel: t.id === sel ? null : t.id }),
    }));
    const me = app.state.me;
    return {
      siteName: d?.name ?? me?.site.name ?? '',
      working: d?.working ?? '–',
      cautionZone: d?.cautionZone ?? '없음',
      cautionColor: d?.cautionZone ? '#ffbe1a' : '#a9b1bb',
      pm10: d?.pm10 ?? '–',
      team,
      mapTeam: team.filter((t) => t.x != null && t.y != null),
      teamCount: team.length,
      me: { has: d?.me.x != null && d?.me.y != null, x: d?.me.x ?? 0, y: d?.me.y ?? 0 },
      notices: d?.notices.map((n) => ({ ...n, detail: n.detail ?? '' })) ?? [],
      noNotices: !!d && d.notices.length === 0,
    };
  }
}

// ---- 08 센서값 ------------------------------------------------------------------------
const W = 310;
function spark(points: { ts: number; v: number }[], limit: number, now = Date.now()) {
  const from = now - 30 * 60_000;
  const xs = points.filter((p) => p.ts >= from);
  const y = (v: number) => Math.round(Math.min(69, Math.max(3, 67.9 - (53.2 * v) / limit)) * 10) / 10;
  if (!xs.length) return { points: '', dotX: -20, dotY: -20, dotT: '', label: '최근 30분 기록이 없어요' };
  const pts = xs.map((p) => `${Math.round(((p.ts - from) / (30 * 60_000)) * W * 10) / 10},${y(p.v)}`);
  const last = xs[xs.length - 1];
  const lx = Math.round(((last.ts - from) / (30 * 60_000)) * W * 10) / 10;
  const ly = y(last.v);
  const lo = Math.round(Math.min(...xs.map((p) => p.v)));
  const hi = Math.round(Math.max(...xs.map((p) => p.v)));
  return {
    points: pts.join(' '),
    dotX: lx - 4,
    dotY: ly - 4,
    dotT: `rotate(45 ${lx} ${ly})`,
    label: `최근 30분 추이. ${lo}에서 ${hi} 사이, 권고치 ${limit}.`,
  };
}

export class Sensor extends DataScreen<SensorLive> {
  protected load = () => api.sensorLive();
  protected every = 60_000;
  renderVals() {
    const d = this.state.data;
    const live = app.state.live;
    const lim = d?.limits ?? { pm10: app.state.status?.zone?.limit ?? 100, pm25: 50, co: 30 };
    const local = history();
    const server = (d?.history ?? []).map((h) => ({ ts: Date.parse(h.ts), pm10: h.pm10, pm25: h.pm25, co: h.co }));
    // server history (uploaded readings) + anything newer recorded on this phone
    const lastServer = server.at(-1)?.ts ?? 0;
    const hist = [...server, ...local.filter((l) => l.ts > lastServer)];
    const latest = live ?? (d?.latest ? { ...d.latest, ts: Date.parse(d.latest.ts) } : null);
    const metric = (key: 'pm10' | 'pm25' | 'co', limit: number, digits = 0) => {
      const v = latest?.[key];
      const look: Look = v == null ? 'none' : levelOf(v, limit);
      return {
        ...badge(look),
        value: v == null ? '–' : digits ? v.toFixed(digits) : Math.round(v),
        limit,
        ...spark(hist.filter((h) => h[key] != null).map((h) => ({ ts: h.ts, v: h[key] as number })), limit),
      };
    };
    const battery = app.state.battery ?? d?.sensor?.battery ?? null;
    const rssi = app.state.rssi;
    return {
      sensorId: app.state.me?.sensor?.id ?? d?.sensor?.id ?? '–',
      linkWord: linkWord(),
      updated: latest ? fmtTime(latest.ts, true) : '–',
      p10: metric('pm10', lim.pm10),
      p25: metric('pm25', lim.pm25),
      co: metric('co', lim.co),
      temp: latest?.temp != null ? latest.temp.toFixed(1) : '–',
      humidity: latest?.humidity != null ? Math.round(latest.humidity) : '–',
      battery: battery != null ? `${battery}%` : '–',
      batteryWidth: battery ?? 0,
      batteryColor: battery != null && battery < 20 ? '#ff5a4a' : '#e3e7eb',
      signal: rssi == null ? '–' : rssi > -65 ? '강함' : rssi > -80 ? '보통' : '약함',
      calibrated: d?.sensor?.calibratedOn?.replace(/-/g, '.') ?? '–',
      firmware: d?.sensor?.firmware ?? '–',
    };
  }
}

// ---- 09 노출량 ------------------------------------------------------------------------
export class ExposureScreen extends DataScreen<Exposure> {
  protected load = () => api.exposure();
  protected every = 60_000;
  renderVals() {
    const d = this.state.data;
    if (!d) return { badge: badge('none'), bars: [], week: [], zones: [], axis: [], barCount: 1, noZones: true, percent: '–', gauge: 0 };
    const limit = d.limit;
    const n = Math.max(1, d.series.length);
    const bars = d.series.map((b, i) => {
      const last = i === d.series.length - 1;
      if (b.avg == null) return { h: 2, c: '#2c333b', now: last };
      return {
        h: Math.round(Math.min(160, ((b.avg / limit) * 100 * 160) / 120) * 10) / 10,
        c: b.avg >= limit ? '#ff5a4a' : b.avg >= limit * 0.8 ? '#ffbe1a' : last ? '#e3e7eb' : '#3f4852',
        now: last,
      };
    });
    const first = d.series[0] ? Number(d.series[0].time.slice(0, 2)) : 0;
    const axis = d.series
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s.time.endsWith(':00') && (Number(s.time.slice(0, 2)) - first) % 2 === 0 && i <= n - 3)
      .map(({ s, i }) => ({ col: `${i + 1} / span 2`, label: s.time.slice(0, 2), color: '#a9b1bb' }));
    if (d.series.length) axis.push({ col: `${n}`, label: '지금', color: '#2bd8f0' });
    const peakBucket = d.series.reduce<{ time: string; avg: number } | null>((m, s) => (s.avg != null && (!m || s.avg > m.avg) ? { time: s.time, avg: s.avg } : m), null);
    const nowAvg = d.series.at(-1)?.avg;
    const days = d.week.filter((w) => w.percent != null);
    const total = Math.max(1, d.workedMinutes);
    return {
      dateLine: [d.dateLabel, d.shiftName].filter(Boolean).join(' · '),
      badge: badge(d.level),
      percent: d.percent,
      gauge: Math.round(Math.min(100, (d.percent / 120) * 100) * 10) / 10,
      gaugeColor: d.level === 'danger' ? '#ff5a4a' : d.level === 'caution' ? '#ffbe1a' : '#e3e7eb',
      average: d.average ?? '–',
      limit,
      worked: { h: Math.floor(d.workedMinutes / 60), m: d.workedMinutes % 60 },
      left: d.minutesLeft ?? '–',
      leftUnit: d.minutesLeft != null ? '분' : '',
      peak: d.peak ? { value: d.peak.value, time: d.peak.time, zone: d.peak.zone ? ` · ${d.peak.zone}` : '' } : { value: '–', time: '', zone: '' },
      alerts: d.alerts,
      bars,
      barCount: n,
      axis,
      seriesLabel: d.series.length
        ? `${d.series[0].time}부터 지금까지 30분 단위 PM10 농도. ${peakBucket ? `${peakBucket.time}에 ${peakBucket.avg}로 가장 높았고, ` : ''}지금은 ${nowAvg ?? '–'}입니다.`
        : '오늘 측정 기록이 없습니다.',
      zones: d.zones.map((z) => ({ name: z.name, h: Math.floor(z.minutes / 60), m: z.minutes % 60, width: Math.round((z.minutes / total) * 100) })),
      noZones: d.zones.length === 0,
      week: d.week.map((w) => ({
        day: w.day,
        v: w.percent == null ? '–' : `${w.percent}%`,
        h: w.percent == null ? 2 : Math.round(Math.min(w.percent, 120) * 0.9),
        c: w.percent == null ? '#2c333b' : w.percent >= 100 ? '#ff5a4a' : w.percent >= 80 ? '#ffbe1a' : w.today ? '#e3e7eb' : '#3f4852',
        tc: w.today ? '#e3e7eb' : '#a9b1bb',
        w: w.today ? 700 : 400,
      })),
      weekAvg: days.length ? `${Math.round(days.reduce((a, w) => a + (w.percent ?? 0), 0) / days.length)}%` : '–',
      weekLabel: `최근 7일 누적 노출량. ${d.week.map((w) => `${w.day} ${w.percent == null ? '기록 없음' : `${w.percent}%`}`).join(', ')}.`,
    };
  }
}

// ---- 10 기록 ---------------------------------------------------------------------------
export class Log extends DataScreen<LogDay, { filter?: string }> {
  protected load = () => api.events();
  renderVals() {
    const filter = this.state.filter || 'all';
    const defs = [
      { id: 'all', label: '전체' },
      { id: 'alert', label: '알림' },
      { id: 'move', label: '이동' },
      { id: 'sensor', label: '센서' },
    ];
    const filters = defs.map((f) => {
      const on = f.id === filter;
      return { label: f.label, on, bg: on ? '#2c333b' : 'transparent', fg: on ? '#e3e7eb' : '#a9b1bb', fw: on ? 700 : 400, pick: () => this.setState({ filter: f.id }) };
    });
    const off = '#3f4852';
    const d = this.state.data;
    const items = (d?.today ?? [])
      .filter((it) => filter === 'all' || it.type === filter || (filter === 'alert' && it.type === 'sos'))
      .map((it) => {
        const danger = it.level === 'danger';
        const caution = it.level === 'caution';
        return {
          time: it.time,
          title: it.title,
          detail: it.detail ?? '',
          hasState: danger || caution,
          word: danger ? '위험' : '주의',
          sBg: danger ? '#35110e' : '#2e2306',
          sFg: danger ? '#ff5a4a' : '#ffbe1a',
          s1: off,
          s2: caution ? '#ffbe1a' : off,
          s3: danger ? '#ff5a4a' : off,
          dot: danger ? '#ff5a4a' : caution ? '#ffbe1a' : '#3f4852',
        };
      });
    const y = d?.yesterday;
    return {
      dateLabel: fmtDate(Date.now()),
      filters,
      items,
      empty: !!d && items.length === 0,
      emptyText: filter === 'all' ? '오늘 기록이 아직 없어요' : '해당하는 기록이 없어요',
      y: {
        percent: y?.percent != null ? `${y.percent}%` : '–',
        word: y ? badge(y.level).word : '',
        detail: y ? `${y.alerts ? `알림 ${y.alerts}건` : '알림 없음'} · 기록 ${y.count}건` : '',
      },
    };
  }
}

// ---- 11 전체 ---------------------------------------------------------------------------
export class More extends Screen {
  renderVals() {
    const me = app.state.me;
    const prefs = app.state.prefs;
    const defs = [
      { id: 'tg-vibe', key: 'vibe', label: '진동 알림' },
      { id: 'tg-big', key: 'big', label: '큰 글씨' },
      { id: 'tg-light', key: 'light', label: '밝은 화면' },
    ] as const;
    const toggles = defs.map((t) => {
      const on = prefs[t.key];
      return {
        id: t.id,
        label: t.label,
        on,
        track: on ? '#e3e7eb' : '#2c333b',
        knob: on ? '#0b0e12' : '#a9b1bb',
        left: on ? 24 : 4,
        flip: () => void app.persist({ prefs: { ...prefs, [t.key]: !on } }),
      };
    });
    return {
      name: me?.name ?? '',
      org: [me?.company, me?.team, me?.shift.name].filter(Boolean).join(' · '),
      sensorId: me?.sensor?.id ?? '센서 없음',
      linkWord: linkWord(),
      battery: app.state.battery != null ? `${app.state.battery}%` : '–',
      toggles,
      managerName: me?.manager ? `${me.manager.name} ${me.manager.title}` : '담당 관리자',
      managerTel: tel(me?.manager?.phone),
      controlTel: tel(me?.site.controlRoomPhone),
      version: `v${__APP_VERSION__}`,
      logout: async (ev: Event) => {
        ev.preventDefault();
        if (!ask('로그아웃할까요? 센서 연결도 끊어져요.')) return;
        await api.logout().catch(() => {});
        await logoutLocal();
        go('main');
      },
    };
  }
}

// ---- 14 SOS ---------------------------------------------------------------------------
type SosState = { p: number; sending: boolean; sent: boolean; flash: boolean; calm: boolean; error: string; sentTime: string };

export class Sos extends Screen<SosState> {
  state: SosState = { p: 0, sending: false, sent: !!app.state.sos, flash: false, calm: false, error: '', sentTime: app.state.sos?.time ?? '' };
  private timer?: number;
  private flashTimer?: number;
  private ac?: AudioContext;
  private sirenOsc?: OscillatorNode;

  unmount() {
    this.stopAll();
  }

  private audio(): AudioContext | null {
    try {
      if (!this.ac) {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        this.ac = new AC();
      }
      if (this.ac.state === 'suspended') void this.ac.resume();
      return this.ac;
    } catch {
      return null;
    }
  }

  private beep(freq: number, dur: number, vol: number) {
    const ac = this.audio();
    if (!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private siren(seconds: number) {
    const ac = this.audio();
    if (!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sawtooth';
    for (let i = 0; i < seconds * 2; i++) o.frequency.setValueAtTime(i % 2 ? 640 : 960, t + i * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.05);
    g.gain.setValueAtTime(0.2, t + seconds - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    o.connect(g);
    g.connect(ac.destination);
    o.start(t);
    o.stop(t + seconds + 0.05);
    this.sirenOsc = o;
  }

  private alarm() {
    this.siren(6);
    haptics.pattern([400, 100, 400, 100, 400, 100, 400]);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    clearInterval(this.flashTimer);
    if (reduce) return this.setState({ flash: true, calm: true });
    let n = 0;
    this.setState({ flash: true, calm: false });
    this.flashTimer = window.setInterval(() => {
      n += 1;
      if (n >= 12) {
        clearInterval(this.flashTimer);
        return this.setState({ flash: false });
      }
      this.setState({ flash: n % 2 === 0 });
    }, 500);
  }

  private stopAll() {
    clearInterval(this.timer);
    clearInterval(this.flashTimer);
    try {
      this.sirenOsc?.stop();
    } catch {
      /* already stopped */
    }
    this.sirenOsc = undefined;
    haptics.stop();
  }

  private async send() {
    this.setState({ p: 1, sending: true, error: '' });
    const pos = await getPosition(4000);
    try {
      const r = await api.sos(pos ?? {});
      app.set({ sos: { id: r.id, time: r.time } });
      this.setState({ sending: false, sent: true, sentTime: r.time });
      this.alarm();
    } catch (e) {
      this.setState({ sending: false, p: 0, error: `${errText(e)} 관제실에 바로 전화해 주세요.` });
      haptics.warn();
    }
  }

  renderVals() {
    const { p, sent, sending, flash, calm } = this.state;
    const start = (ev: Event) => {
      ev.preventDefault();
      if (this.state.sent || this.state.sending) return;
      clearInterval(this.timer);
      this.beep(880, 0.08, 0.2);
      haptics.tick();
      this.timer = window.setInterval(() => {
        const prev = this.state.p;
        const np = Math.min(1, prev + 0.05);
        if (np >= 1) {
          clearInterval(this.timer);
          void this.send();
        } else {
          if (Math.floor(np * 3 + 1e-6) > Math.floor(prev * 3 + 1e-6)) {
            this.beep(880, 0.08, 0.2);
            haptics.tick();
          }
          this.setState({ p: np });
        }
      }, 150);
    };
    const stop = () => {
      if (this.state.sent || this.state.sending) return;
      clearInterval(this.timer);
      this.setState({ p: 0 });
    };
    const reset = async () => {
      this.stopAll();
      const id = app.state.sos?.id;
      app.set({ sos: null });
      this.setState({ p: 0, sent: false, flash: false, calm: false });
      if (id) await api.cancelSos(id).catch(() => {});
    };
    const st = app.state.status;
    const cur = current();
    const secs = Math.max(1, Math.ceil(3 - p * 3));
    return {
      headline: sent ? '관제실에\n알렸어요' : sending ? '보내는 중이에요' : '3초 동안\n꾹 눌러주세요',
      dash: sent || sending ? 0 : Math.round((100 - p * 100) * 10) / 10,
      big: sent ? 'SENT' : 'SOS',
      plate: sent ? `${this.state.sentTime} · 반장 · 관제실` : sending ? 'SENDING' : 'HOLD ' + secs + 'S',
      sent,
      flashOpacity: flash ? (calm ? 0.18 : 0.42) : 0,
      callBg: sent || this.state.error ? '#e3e7eb' : '#1c2127',
      callFg: sent || this.state.error ? '#0b0e12' : '#e3e7eb',
      callHref: tel(app.state.me?.site.controlRoomPhone),
      where: st?.zone ? [st.zone.name, st.zone.spot].filter(Boolean).join(' ') : '–',
      pm10: cur.value ?? '–',
      time: sent ? this.state.sentTime : fmtTime(Date.now()),
      statusText: sent ? '관제실과 반장님께 SOS를 보냈어요' : '',
      error: this.state.error,
      start,
      stop,
      reset: () => void reset(),
    };
  }
}
