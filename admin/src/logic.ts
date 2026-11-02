// Screen logic for the admin dashboard. Each class feeds one design artboard
// (admin/src/markup/*.html) through renderVals(); colours and states follow the
// design's own preview logic (design/admin/*.dc.html).
import { Screen } from '../../src/dc';
import {
  api,
  setToken,
  type AlertItem,
  type AlertList,
  type FormOptions,
  type Invite,
  type Overview,
  type Report,
  type Rules,
  type SensorList,
  type Settings,
  type SiteCard,
  type WorkerDetail,
  type WorkerRow,
} from './api';
import { logout, refreshPending, session } from './session';
import { C, SOFT, badge, chip, copyText, download, errText, inputValue, levelOf, pctColor, seg, tempPassword, toast, today, WORD, type Lvl } from './ui';

type Vals = Record<string, unknown>;

/** Screens behind the sidebar: nav badge, polling that stops on leave, guarded loads. */
abstract class AdminScreen<S extends Vals = Vals> extends Screen<S> {
  private timers: number[] = [];
  protected alive = true;
  protected readonly site = session.state.siteId ?? 0;

  protected nav() {
    const a = session.state.admin;
    return {
      alerts: session.state.pending,
      site: session.state.siteName,
      admin: a ? [a.name, a.title].filter(Boolean).join(' · ') : '',
      logout: (ev: Event) => {
        ev.preventDefault();
        void logout();
      },
    };
  }
  protected poll(ms: number, fn: () => unknown) {
    void fn();
    this.timers.push(window.setInterval(() => !document.hidden && void fn(), ms));
  }
  protected later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms));
  }
  protected async guard<T>(p: Promise<T>, quiet = false): Promise<T | null> {
    try {
      return await p;
    } catch (e) {
      if (!quiet) toast(errText(e));
      return null;
    }
  }
  protected readOnly() {
    if (session.canEdit()) return false;
    toast('보기 전용 계정이에요');
    return true;
  }
  unmount() {
    this.alive = false;
    this.timers.forEach((t) => clearInterval(t));
  }
}

const fmtDur = (min: number) => (min < 60 ? `${min}분` : `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ''}`);
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// ---- 로그인 -------------------------------------------------------------------------------
export class Login extends Screen<{ username: string; password: string; remember: boolean; busy: boolean; error: string; info: string }> {
  state = { username: '', password: '', remember: true, busy: false, error: '', info: '' };

  private async submit() {
    const { username, password, remember, busy } = this.state;
    if (busy) return;
    if (!username.trim() || !password) return this.setState({ error: '아이디와 비밀번호를 입력해 주세요.', info: '' });
    this.setState({ busy: true, error: '', info: '' });
    try {
      const r = await api.login(username.trim(), password, remember);
      setToken(r.token, remember);
      session.set({ admin: r.admin });
      location.hash = '#sites';
    } catch (e) {
      this.setState({ busy: false, error: errText(e), password: '' });
    }
  }

  mounted(root: HTMLElement) {
    root.querySelector<HTMLInputElement>('#username')?.focus();
  }

  renderVals() {
    const s = this.state;
    return {
      ...s,
      opacity: s.busy ? 0.6 : 1,
      label: s.busy ? '확인하는 중…' : '로그인',
      onUser: (ev: Event) => this.setState({ username: inputValue(ev), error: '' }),
      onPass: (ev: Event) => this.setState({ password: inputValue(ev), error: '' }),
      onKey: (ev: KeyboardEvent) => ev.key === 'Enter' && void this.submit(),
      onRemember: (ev: Event) => this.setState({ remember: (ev.target as HTMLInputElement).checked }),
      submit: () => void this.submit(),
      forgot: () => this.setState({ error: '', info: '소유자에게 임시 비밀번호를 요청해 주세요. 소유자 계정은 서버에서 invisen-admin admin-password 명령으로 바꿀 수 있어요.' }),
      askAccount: () => this.setState({ error: '', info: '관리자 계정은 소유자가 설정 › 관리자에서 만들어요.' }),
    };
  }
}

// ---- 현장 선택 ------------------------------------------------------------------------------
export class Sites extends AdminScreen<{ sites: SiteCard[] | null }> {
  state = { sites: null as SiteCard[] | null };

  mounted() {
    void this.guard(api.sites()).then((sites) => this.alive && this.setState({ sites: sites ?? [] }));
  }
  loading() {
    return this.state.sites === null;
  }

  renderVals() {
    const sites = this.state.sites ?? [];
    const a = session.state.admin;
    return {
      admin: a ? [a.name, a.title].filter(Boolean).join(' · ') : '',
      logout: (ev: Event) => {
        ev.preventDefault();
        void logout();
      },
      subtitle: `관리 권한이 있는 현장 ${sites.length}곳`,
      sites: sites.map((c) => {
        const l: Lvl = c.danger ? 'danger' : c.caution ? 'caution' : 'safe';
        const sub = [c.facility, c.zones ? `구역 ${c.zones.split(' · ').length}개` : null].filter(Boolean).join(' · ');
        return {
          active: c.status === 'active',
          preparing: c.status !== 'active',
          name: c.name,
          sub,
          note: '센서 설치 전이에요 · 준비되면 열려요',
          working: c.working,
          sensors: `${c.sensorsOnline}/${c.sensorsTotal}`,
          bar: l === 'safe' ? C.seg : C[l],
          b: badge(l, C.seg2),
          badge: l === 'danger' ? `위험 ${c.danger}명` : l === 'caution' ? `주의 ${c.caution}명` : '안전',
          pick: () => session.pickSite(c.id, c.name),
        };
      }),
    };
  }
}

// ---- alert presentation shared by 관제 홈 and 알림 ------------------------------------------
const alertLevel = (a: AlertItem): Lvl => (a.type === 'danger' || a.type === 'sos' ? 'danger' : a.type === 'caution' || a.type === 'advice' ? 'caution' : 'off');
const statusFg = (a: AlertItem) => (a.pending ? C.ink : a.status === 'resolved' || a.status === 'auto' ? C.safe : C.muted);

// ---- 관제 홈 --------------------------------------------------------------------------------
export class Home extends AdminScreen<{ data: Overview | null; sel: number | null; filter: 'all' | 'c' | 'd' }> {
  state = { data: null as Overview | null, sel: null as number | null, filter: 'all' as 'all' | 'c' | 'd' };

  mounted() {
    this.poll(10_000, async () => {
      const data = await this.guard(api.overview(this.site), this.state.data !== null);
      if (data && this.alive) this.setState({ data });
      void refreshPending();
    });
  }
  loading() {
    return this.state.data === null;
  }
  private async ack(id: number) {
    if (this.readOnly()) return;
    if (await this.guard(api.ack(id))) {
      toast('알림을 확인했어요');
      const data = await this.guard(api.overview(this.site));
      if (data) this.setState({ data });
      void refreshPending();
    }
  }

  renderVals() {
    const d = this.state.data;
    const { sel, filter } = this.state;
    if (!d) return { nav: this.nav() };
    const k = d.kpis;
    const lvl = (s: string): Lvl => (s === 'danger' ? 'danger' : s === 'caution' ? 'caution' : s === 'off' ? 'off' : 'safe');
    const ws = d.workers.map((w) => {
      const l = lvl(w.state);
      const selected = w.id === sel;
      const b = badge(l);
      return {
        wid: w.id,
        id: w.employeeNo,
        n: w.name,
        initial: w.name.slice(0, 1),
        z: w.zone ?? '–',
        x: w.x,
        y: w.y,
        l,
        pmText: w.pm10 == null ? '–' : String(w.pm10),
        cumText: `${w.cum}%`,
        barW: Math.min(100, w.cum),
        barC: pctColor(w.cum),
        word: b.word,
        bBg: b.soft,
        bFg: b.color,
        s1: b.s1,
        s2: b.s2,
        s3: b.s3,
        scaleDisplay: b.scaleDisplay,
        batText: l === 'off' ? '끊김' : w.battery == null ? '–' : `${w.battery}%`,
        dotBg: l === 'off' ? 'transparent' : l === 'safe' ? C.muted : C[l],
        dotBd: l === 'off' ? C.faint : l === 'safe' ? C.muted : C[l],
        sel: selected,
        rowBg: selected ? C.signalSoft : 'transparent',
        pick: () => this.setState({ sel: selected ? null : w.id }),
      };
    });
    const cautionN = ws.filter((w) => w.l === 'caution' || w.l === 'danger').length;
    const offN = ws.filter((w) => w.l === 'off').length;
    const rows = filter === 'c' ? ws.filter((w) => w.l === 'caution' || w.l === 'danger') : filter === 'd' ? ws.filter((w) => w.l === 'off') : ws.slice(0, 10);
    const zoneTile = (z: Overview['zones'][number]) => {
      const hot = z.level !== 'safe';
      return {
        bg: hot ? SOFT[z.level] : C.well,
        fg: hot ? C[z.level] : C.muted,
        fw: hot ? 700 : 400,
        label: hot ? `${z.name} · ${WORD[z.level]}` : z.name,
        avg: z.avg ?? '–',
        workers: z.workers,
      };
    };
    const zones = d.zones.map(zoneTile);
    const markers = ws.filter((w) => w.x != null && w.y != null);
    const canEdit = session.canEdit();
    return {
      nav: this.nav(),
      subtitle: d.facility || d.siteName,
      dateLabel: d.dateLabel,
      time: d.time,
      k: {
        ...k,
        avg: k.avgPm10 ?? '–',
        cautionFg: k.caution ? C.caution : C.ink,
        dangerFg: k.danger ? C.danger : C.ink,
      },
      zones,
      zoneCols: Math.max(1, zones.length),
      // the floor plan draws 1~5구역 at fixed places: match by the zone's number, not list order
      mapZones: Array.from({ length: 5 }, (_, i) => {
        const z = d.zones.find((x) => x.name.match(/^(\d+)/)?.[1] === String(i + 1));
        if (!z) return { label: `${i + 1}구역`, fg: C.dim, fill: 'transparent', stroke: 'transparent' };
        const t = zoneTile(z);
        const hot = z.level !== 'safe';
        return { label: t.label, fg: hot ? t.fg : C.muted, fill: hot ? SOFT[z.level] : 'transparent', stroke: hot ? C[z.level] : 'transparent' };
      }),
      restCount: d.restCount,
      markers,
      mapLabel: `현장 도면 · 작업자 ${markers.length}명 위치${cautionN ? ` · 주의 ${cautionN}명` : ''}`,
      rows,
      filters: [seg('전체', filter === 'all', () => this.setState({ filter: 'all' })), seg(`주의 ${cautionN}`, filter === 'c', () => this.setState({ filter: 'c' })), seg(`연결 끊김 ${offN}`, filter === 'd', () => this.setState({ filter: 'd' }))],
      allLabel: `${ws.length}명 모두 보기`,
      alerts: d.alerts.map((a) => {
        const l = alertLevel(a);
        const canAck = canEdit && a.status === 'open';
        return {
          b: badge(l, C.seg2),
          cat: a.cat,
          advice: a.advice,
          statusFg: statusFg(a),
          statusLabel: a.statusLabel,
          time: a.time,
          titleFg: l === 'danger' && a.pending ? C.danger : C.ink,
          title: a.title,
          sub: a.sub ?? '',
          primary: a.pending ? a.primary : null,
          canAck,
          actions: (a.pending && !!a.primary) || canAck,
          ack: () => void this.ack(a.id),
        };
      }),
      noAlerts: d.alerts.length === 0,
    };
  }
}

// ---- 작업자 --------------------------------------------------------------------------------
type WorkersState = {
  rows: WorkerRow[] | null;
  options: FormOptions | null;
  filter: 'all' | 'on' | 'pending' | 'off';
  query: string;
  open: boolean;
  form: { name: string; employeeNo: string; phone: string; org: string; zoneIds: number[]; shift: string };
  saved: { id: number; name: string } | null;
  invite: Invite | null;
  busy: boolean;
  error: string;
  copied: boolean;
  now: number;
};
const emptyForm = () => ({ name: '', employeeNo: '', phone: '', org: '', zoneIds: [] as number[], shift: '' });

export class Workers extends AdminScreen<WorkersState> {
  state: WorkersState = { rows: null, options: null, filter: 'all', query: '', open: false, form: emptyForm(), saved: null, invite: null, busy: false, error: '', copied: false, now: Date.now() };

  mounted() {
    this.poll(30_000, () => this.load());
    this.poll(1000, () => (this.state.open || this.state.rows?.some((r) => r.conn === 'pending')) && this.setState({ now: Date.now() }));
    void this.guard(api.formOptions(this.site), true).then((options) => options && this.alive && this.setState({ options }));
    void refreshPending();
  }
  loading() {
    return this.state.rows === null;
  }
  private async load() {
    const rows = await this.guard(api.workers(this.site), this.state.rows !== null);
    if (rows && this.alive) this.setState({ rows });
  }
  private openNew() {
    if (this.readOnly()) return;
    this.setState({ open: true, form: emptyForm(), saved: null, invite: null, error: '', copied: false });
    setTimeout(() => document.querySelector<HTMLInputElement>('#f-name')?.focus(), 60);
  }
  private close() {
    this.setState({ open: false });
    void this.load();
  }
  private async save() {
    const f = this.state.form;
    if (this.state.busy) return;
    if (!f.name.trim() || !f.employeeNo.trim()) return this.setState({ error: '이름과 사번을 적어 주세요.' });
    if (!/^01\d{8,9}$/.test(f.phone.replace(/\D/g, ''))) return this.setState({ error: '휴대폰 번호를 확인해 주세요.' });
    this.setState({ busy: true, error: '' });
    try {
      const r = await api.addWorker(this.site, {
        name: f.name.trim(),
        employeeNo: f.employeeNo.trim(),
        phone: f.phone,
        org: f.org.trim() || undefined,
        zoneIds: f.zoneIds,
        shift: f.shift || undefined,
      });
      this.setState({ busy: false, saved: { id: r.worker.id, name: r.worker.name }, invite: r.invite });
      toast(`${r.worker.name} 님을 등록했어요`);
    } catch (e) {
      this.setState({ busy: false, error: errText(e) });
    }
  }
  private async reissue(w: { id: number; name: string; employeeNo: string; phone: string; org: string; zone: string | null; shift: string | null }, ask = true) {
    if (this.readOnly()) return;
    if (ask && !confirm(`${w.name} 님의 새 로그인 코드를 만들까요?\n이전 코드는 더 이상 쓸 수 없어요.`)) return;
    const invite = await this.guard(api.invite(w.id));
    if (!invite) return;
    const zoneIds = this.state.options?.zones.filter((z) => z.name === w.zone).map((z) => z.id) ?? [];
    this.setState({
      open: true,
      saved: { id: w.id, name: w.name },
      invite,
      error: '',
      copied: false,
      form: { name: w.name, employeeNo: w.employeeNo, phone: w.phone, org: w.org, zoneIds, shift: w.shift ?? '' },
    });
  }
  private async deactivate(w: WorkerRow) {
    if (this.readOnly()) return;
    if (!confirm(`${w.name} 님을 목록에서 뺄까요?\n앱 로그인이 끊기고 센서 배정이 풀려요. 측정 기록은 남아요.`)) return;
    if (await this.guard(api.setWorkerActive(w.id, false))) {
      toast(`${w.name} 님을 목록에서 뺐어요`);
      void this.load();
    }
  }
  private left(expiresAt: string | null) {
    if (!expiresAt) return 0;
    return Math.max(0, Math.floor((Date.parse(expiresAt) - this.state.now) / 1000));
  }

  renderVals() {
    const s = this.state;
    const all = s.rows ?? [];
    const q = s.query.trim().toLowerCase();
    const counts = { on: all.filter((w) => w.conn === 'on').length, pending: all.filter((w) => w.conn === 'pending').length, off: all.filter((w) => w.conn === 'off').length };
    const list = all.filter((w) => (s.filter === 'all' || w.conn === s.filter) && (!q || w.name.toLowerCase().includes(q) || w.employeeNo.toLowerCase().includes(q) || w.phone.includes(q.replace(/\D/g, '') || '\u0000')));
    const rows = list.map((w) => {
      const sec = this.left(w.inviteExpiresAt);
      const h = Math.floor(sec / 3600);
      const pendingLabel = !w.inviteExpiresAt || sec === 0 ? '코드 만료' : h >= 1 ? `코드 대기 · ${h}시간 남음` : `코드 대기 · ${Math.ceil(sec / 60)}분 남음`;
      return {
        wid: w.id,
        id: w.employeeNo,
        n: w.name,
        initial: w.name.slice(0, 1),
        org: w.org || '–',
        z: w.zone ?? '–',
        shift: w.shift ?? '–',
        sensor: w.sensor ?? '–',
        pending: w.conn === 'pending',
        notPending: w.conn !== 'pending',
        conn: w.conn === 'pending' ? pendingLabel : w.conn === 'off' ? '연결 끊김' : '연결됨',
        connFg: w.conn === 'on' ? C.ink : C.muted,
        connDot: w.conn === 'on' ? C.ink : 'transparent',
        connBd: w.conn === 'on' ? C.ink : w.conn === 'pending' ? C.signal : C.faint,
        codeLabel: '새 코드',
        openModal: () => void this.reissue(w),
        menuLabel: `${w.name} 목록에서 빼기`,
        menu: () => void this.deactivate(w),
      };
    });
    const sec = this.left(s.invite?.expiresAt ?? null);
    const hh = Math.floor(sec / 3600);
    const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const code = s.invite?.code ?? '';
    const f = s.form;
    const setForm = (patch: Partial<WorkersState['form']>) => this.setState({ form: { ...this.state.form, ...patch }, error: '' });
    const locked = !!s.saved;
    return {
      nav: this.nav(),
      subtitle: `등록 ${all.length}명 · 앱 연결 ${counts.on}명`,
      query: s.query,
      onSearch: (ev: Event) => this.setState({ query: inputValue(ev) }),
      filters: [
        seg(`전체 ${all.length}`, s.filter === 'all', () => this.setState({ filter: 'all' })),
        seg(`연결됨 ${counts.on}`, s.filter === 'on', () => this.setState({ filter: 'on' })),
        seg(`코드 대기 ${counts.pending}`, s.filter === 'pending', () => this.setState({ filter: 'pending' })),
        seg(`연결 끊김 ${counts.off}`, s.filter === 'off', () => this.setState({ filter: 'off' })),
      ],
      rows,
      open: s.open,
      openModal: () => this.openNew(),
      closeModal: () => this.close(),
      modalHint: locked ? '앱 로그인 코드를 작업자에게 전달해 주세요 · 72시간 동안 한 번 쓸 수 있어요' : '정보를 저장하면 앱 로그인 코드가 만들어져요',
      form: f,
      saved: locked,
      notSaved: !locked,
      onName: (ev: Event) => setForm({ name: inputValue(ev) }),
      onEmp: (ev: Event) => setForm({ employeeNo: inputValue(ev) }),
      onPhone: (ev: Event) => setForm({ phone: inputValue(ev) }),
      onOrg: (ev: Event) => setForm({ org: inputValue(ev) }),
      orgs: s.options?.orgs ?? [],
      zoneChips: (s.options?.zones ?? []).map((z) =>
        chip(z.name, f.zoneIds.includes(z.id), () => !locked && setForm({ zoneIds: f.zoneIds.includes(z.id) ? f.zoneIds.filter((x) => x !== z.id) : [...f.zoneIds, z.id] })),
      ),
      shiftChips: (s.options?.shifts ?? []).map((sh) => chip(`${sh.name} ${sh.start}–${sh.end}`, f.shift === sh.name, () => !locked && setForm({ shift: f.shift === sh.name ? '' : sh.name }))),
      error: s.error,
      busy: s.busy,
      primaryLabel: locked ? '완료' : s.busy ? '저장하는 중…' : '저장하고 코드 만들기',
      primary: () => (locked ? this.close() : void this.save()),
      digits: (code || '------').split('').map((v) => ({ v: code ? v : '–' })),
      codeLabel: code ? `로그인 코드 ${code.split('').join(' ')}` : '코드는 저장하면 만들어져요',
      timer: code ? `${hh}:${mm}:${ss}` : '72:00:00',
      timerColor: code && sec < 3600 ? C.caution : C.ink,
      copyLabel: s.copied ? '복사했어요' : '코드 복사',
      copy: async () => {
        if (!code) return this.setState({ error: '먼저 저장해 주세요.' });
        await copyText(code);
        this.setState({ copied: true });
        this.later(1600, () => this.alive && this.setState({ copied: false }));
      },
      regen: () => {
        if (!s.saved) return this.setState({ error: '먼저 저장해 주세요.' });
        const w = all.find((x) => x.id === s.saved!.id);
        void this.reissue(w ?? { id: s.saved.id, name: s.saved.name, employeeNo: f.employeeNo, phone: f.phone, org: f.org, zone: null, shift: f.shift || null }, true);
      },
    };
  }
}

// ---- 작업자 상세 ------------------------------------------------------------------------------
export class Worker extends AdminScreen<{ d: WorkerDetail | null; missing: boolean; sent: boolean; toast: boolean; toastText: string }> {
  state = { d: null as WorkerDetail | null, missing: false, sent: false, toast: false, toastText: '' };
  constructor(private readonly id: number) {
    super();
  }

  mounted() {
    this.poll(15_000, async () => {
      try {
        const d = await api.worker(this.id);
        if (this.alive) this.setState({ d });
      } catch (e) {
        if (this.state.d === null) {
          toast(errText(e));
          location.hash = '#workers';
        }
      }
    });
    void refreshPending();
  }
  loading() {
    return this.state.d === null;
  }
  private async order() {
    const d = this.state.d;
    if (!d || this.state.sent || this.readOnly()) return;
    const r = await this.guard(api.shiftOrder(d.id));
    if (!r) return;
    const text = r.pushed ? `교대 지시를 보냈어요 · ${d.name} 님 앱에 알림` : '교대 지시를 기록했어요 · 앱 푸시는 설정 후 전달돼요';
    this.setState({ sent: true, toast: true, toastText: text });
    this.later(2800, () => this.alive && this.setState({ toast: false }));
    const fresh = await this.guard(api.worker(d.id), true);
    if (fresh && this.alive) this.setState({ d: fresh });
  }
  private async csv(days: number) {
    const d = this.state.d;
    if (!d) return;
    const res = await this.guard(api.readingsCsv(d.id, days));
    // ASCII name: several browsers drop non-ASCII download names
    const emp = d.employeeNo.replace(/[^A-Za-z0-9-]/g, '') || `worker-${d.id}`;
    if (res) await download(res, `invisen_${emp}_${days === 1 ? today() : `last${days}d-${today()}`}.csv`);
  }

  renderVals() {
    const d = this.state.d;
    if (!d) return { nav: this.nav() };
    const lvl: Lvl = d.state === 'danger' ? 'danger' : d.state === 'caution' ? 'caution' : d.state === 'off' ? 'off' : 'safe';
    const nowL = levelOf(d.pm10, d.limit);
    const pct = d.pm10 == null ? null : Math.round((d.pm10 / d.limit) * 100);
    // chart: 200px = 120% of the limit, limit lines at 100% and 80%
    const bars = d.bars.map((b, i) => {
      const v = b.avg ?? 0;
      return {
        h: b.avg == null ? 2 : Math.max(2, Math.min(200, Math.round((v / (d.limit * 1.2)) * 2000) / 10)),
        c: b.avg == null ? C.seg : v >= d.limit ? C.danger : v >= d.limit * 0.8 ? C.caution : C.seg2,
        now: i === d.bars.length - 1,
      };
    });
    const step = d.bars.length > 24 ? 4 : 2;
    const axis = d.bars
      .map((b, i) => ({ i, b }))
      .filter(({ i }) => i % step === 0)
      .map(({ i, b }) => ({ col: `${i + 1} / span ${step}`, color: C.muted, label: b.time.slice(0, 2) }));
    // zone stays across the shift (or from the first reading to now)
    const segs = d.segments;
    let start = d.shiftTime ? toMin(d.shiftTime.split('–')[0]) : segs[0] ? toMin(segs[0].from) : 0;
    let end = d.shiftTime ? toMin(d.shiftTime.split('–')[1]) : start + 8 * 60;
    if (end <= start) end += 1440;
    const at = (hhmm: string) => {
      let m = toMin(hhmm);
      if (m < start - 120) m += 1440;
      return m;
    };
    // readings before the shift or overtime stretch the bar
    if (segs[0]) start = Math.min(start, at(segs[0].from));
    if (segs.length) end = Math.max(end, at(segs.at(-1)!.to) + 1);
    const total = Math.max(1, end - start);
    const share = (m: number) => Math.round((m / total) * 1000) / 10;
    const segments: { w: number; pad: number; bg: string; bd: string; fw: number; fg: string; label: string }[] = [];
    let cursor = start;
    segs.forEach((g, i) => {
      const from = at(g.from);
      // time without readings stays empty, so each stay sits at its real time
      if (from - cursor >= 2) segments.push({ w: share(from - cursor), pad: 0, bg: 'transparent', bd: 'transparent', fw: 400, fg: C.muted, label: '' });
      const w = Math.max(0.6, share(at(g.to) - from + 1));
      const last = i === segs.length - 1;
      const rest = g.zone.includes('휴게');
      segments.push({
        w,
        pad: w > 6 ? 10 : 2,
        bg: last ? C.signalSoft : rest ? C.panel : C.chip,
        bd: last ? C.signal : rest ? C.seg2 : C.dim,
        fw: last ? 700 : 400,
        fg: last ? C.ink : C.muted,
        label: w > 8 ? g.zone : '',
      });
      cursor = Math.max(cursor, at(g.to) + 1);
    });
    const lastSeg = segs.at(-1);
    const nowPos = lastSeg ? Math.min(100, ((at(lastSeg.to) - start) / total) * 100) : null;
    const hm = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const segLabels = [
      { left: 0, tx: 'none', color: C.muted, t: hm(start) },
      ...(nowPos != null && nowPos > 12 && nowPos < 88 ? [{ left: Math.round(nowPos * 10) / 10, tx: 'translateX(-50%)', color: C.signal, t: lastSeg!.to }] : []),
      { left: 100, tx: 'translateX(-100%)', color: C.muted, t: hm(end) },
    ];
    const evDot = (e: WorkerDetail['events'][number]) => (e.level === 'danger' ? C.danger : e.level === 'caution' ? C.caution : e.type === 'request' ? C.signal : C.seg2);
    const sn = d.sensor;
    return {
      nav: this.nav(),
      name: d.name,
      initial: d.initial,
      b: badge(lvl),
      employeeNo: d.employeeNo,
      meta: [d.org, d.shift].filter(Boolean).map((x) => ` · ${x}`).join(''),
      tel: `tel:${d.phone}`,
      pm10: d.pm10 ?? '–',
      nowFg: nowL === 'off' ? C.muted : nowL === 'safe' ? C.ink : C[nowL],
      nowNote: pct == null ? '최근 2분간 측정값이 없어요' : `권고치의 ${pct}% · ${WORD[nowL]}`,
      cum: d.cum,
      cumW: Math.min(100, d.cum),
      cumC: pctColor(d.cum),
      zone: d.zone ?? '–',
      zoneNote: [d.spot, d.zoneSinceMin != null ? `${fmtDur(d.zoneSinceMin)}째` : null].filter(Boolean).join(' · ') || '위치 기록 없음',
      sensorId: sn?.id ?? '없음',
      sensorNote: sn ? [sn.connected ? '연결됨' : `끊김${sn.lastSeen ? ` · 마지막 ${sn.lastSeen}` : ''}`, sn.battery != null ? `배터리 ${sn.battery}%` : null].filter(Boolean).join(' · ') : '배정된 센서가 없어요',
      bars,
      barCount: Math.max(1, bars.length),
      axis,
      limitLabel: d.limit,
      cautionLabel: Math.round(d.limit * 0.8),
      barsLabel: bars.length ? `오늘 30분 단위 PM10. ${d.bars.map((b) => `${b.time} ${b.avg ?? '없음'}`).join(', ')}` : '오늘 측정 기록이 없어요',
      shiftTime: d.shiftTime ?? `${hm(start)}–${hm(end)}`,
      segments,
      segLabels,
      segLabel: segs.length ? `구역 체류. ${segs.map((g) => `${g.from}–${g.to} ${g.zone}`).join(', ')}` : '오늘 구역 기록이 없어요',
      events: d.events.map((e) => ({ t: e.time, dot: evDot(e), fg: C.ink, title: e.title, sub: e.detail ?? '' })),
      week: d.week.map((w) => ({
        day: w.day,
        v: w.percent == null ? '–' : `${w.percent}%`,
        h: w.percent == null ? 2 : Math.min(140, Math.round(w.percent * 1.2)),
        c: w.percent == null ? C.seg : w.percent >= 100 ? C.danger : w.percent >= 80 ? C.caution : C.dim,
        tc: w.today ? C.ink : C.muted,
        w: w.today ? 700 : 400,
      })),
      weekNote: d.weekNote,
      weekLabel: `최근 7일 누적 노출량. ${d.week.map((w) => `${w.day} ${w.percent == null ? '기록 없음' : `${w.percent}%`}`).join(', ')}`,
      advice: d.advice,
      order: () => void this.order(),
      orderLabel: this.state.sent ? '교대 지시 보냄' : '교대 지시',
      orderBg: this.state.sent ? C.chip : C.ink,
      orderFg: this.state.sent ? C.muted : '#0b0e12',
      toast: this.state.toast,
      toastText: this.state.toastText,
      csvToday: () => void this.csv(1),
      csvMonth: () => void this.csv(30),
    };
  }
}

// ---- 알림 ---------------------------------------------------------------------------------
type AlertFilter = 'all' | 'pending' | 'danger' | 'caution' | 'sensor' | 'notice';
export class Alerts extends AdminScreen<{ data: AlertList | null; day: 'today' | 'yesterday'; sel: number | null; filter: AlertFilter }> {
  state = { data: null as AlertList | null, day: 'today' as 'today' | 'yesterday', sel: null as number | null, filter: 'all' as AlertFilter };

  mounted() {
    this.poll(15_000, () => this.load(true));
  }
  loading() {
    return this.state.data === null;
  }
  private async load(quiet = false) {
    const data = await this.guard(api.alerts(this.site, this.state.day), quiet && this.state.data !== null);
    if (data && this.alive && data.day === this.state.day) this.setState({ data });
    if (data && data.pending !== session.state.pending) session.set({ pending: data.pending });
  }
  private async resolve(id: number) {
    if (this.readOnly()) return;
    if (await this.guard(api.resolve(id))) {
      toast('처리 완료로 표시했어요');
      void this.load();
    }
  }
  private match(a: AlertItem) {
    switch (this.state.filter) {
      case 'pending':
        return a.pending;
      case 'danger':
        return a.type === 'danger' || a.type === 'sos';
      case 'caution':
        return a.type === 'caution' || a.type === 'advice';
      case 'all':
        return true;
      default:
        return a.type === this.state.filter;
    }
  }

  renderVals() {
    const data = this.state.data;
    if (!data) return { nav: this.nav() };
    const { filter, day } = this.state;
    const items = data.list;
    const list = items.filter((a) => this.match(a));
    const cur = list.find((a) => a.id === this.state.sel) ?? list[0] ?? null;
    const look = (a: AlertItem) => {
      const l = alertLevel(a);
      const b = badge(l, C.seg2);
      return { bBg: b.soft, bFg: b.color, s1: b.s1, s2: b.s2, s3: b.s3, scaleDisplay: l === 'off' ? 'none' : 'flex', stFg: statusFg(a), stW: a.pending ? 700 : 400, status: a.statusLabel, cat: a.cat };
    };
    const count = (f: (a: AlertItem) => boolean) => items.filter(f).length;
    const pendingN = count((a) => a.pending);
    const y = data.yesterday;
    const canEdit = session.canEdit();
    const d = cur
      ? {
          ...look(cur),
          t: cur.time,
          title: cur.title,
          sub: cur.sub ?? '',
          danger: cur.type === 'danger' || cur.type === 'sos',
          metrics: cur.metrics.map(([k, v]) => ({ k, v })),
          hasRec: !!cur.rec,
          rec: cur.rec ?? '',
          hasPeople: cur.people.length > 0,
          people: cur.people.map((p) => ({ id: p.id, n: p.name, i: p.name.slice(0, 1) })),
          timeline: cur.timeline.map(([t, x], i) => ({ t, x, dot: x.startsWith('처리 완료') || x.startsWith('자동') ? C.safe : i === cur.timeline.length - 1 ? C.ink : C.dim })),
          pending: cur.pending && canEdit,
          primary: cur.primary?.label ?? '',
          primaryHref: cur.primary?.href ?? '#alerts',
          resolve: () => void this.resolve(cur.id),
        }
      : { bBg: C.chip, bFg: C.muted, scaleDisplay: 'none', cat: '알림', t: '', status: '', title: '선택한 알림이 없어요', sub: '왼쪽 목록에서 알림을 고르면 자세한 내용이 보여요', metrics: [], timeline: [], people: [] };
    return {
      nav: this.nav(),
      subtitle: day === 'today' ? `오늘 ${items.length}건 · 처리 대기 ${data.pending}건` : `어제 ${items.length}건`,
      listLabel: `${day === 'today' ? '오늘' : '어제'} · ${data.dateLabel}`,
      filters: [
        seg(`전체 ${items.length}`, filter === 'all', () => this.setState({ filter: 'all' })),
        seg(`대기 ${pendingN}`, filter === 'pending', () => this.setState({ filter: 'pending' })),
        seg(`위험 ${count((a) => a.type === 'danger' || a.type === 'sos')}`, filter === 'danger', () => this.setState({ filter: 'danger' })),
        seg(`주의 ${count((a) => a.type === 'caution' || a.type === 'advice')}`, filter === 'caution', () => this.setState({ filter: 'caution' })),
        seg(`센서 ${count((a) => a.type === 'sensor')}`, filter === 'sensor', () => this.setState({ filter: 'sensor' })),
        seg(`공지 ${count((a) => a.type === 'notice')}`, filter === 'notice', () => this.setState({ filter: 'notice' })),
      ],
      rows: list.map((a) => ({
        ...look(a),
        t: a.time,
        ai: a.advice,
        title: a.title,
        sub: a.sub ?? '',
        sel: a.id === cur?.id,
        rowBg: a.id === cur?.id ? C.signalSoft : 'transparent',
        pick: () => this.setState({ sel: a.id }),
      })),
      empty: list.length === 0,
      emptyText: items.length ? '이 조건에 맞는 알림이 없어요' : day === 'today' ? '오늘 알림이 없어요' : '어제 알림이 없어요',
      d,
      dayToggle: day === 'yesterday' ? '오늘 알림으로 돌아가기' : y.n ? `어제 · ${y.n}건 · ${y.open ? `${y.open}건 처리 대기` : '모두 처리 완료'}` : '어제 · 알림 없음',
      dayArrow: day === 'yesterday' ? 'rotate(180deg)' : 'none',
      toggleDay: () => {
        this.setState({ day: day === 'today' ? 'yesterday' : 'today', sel: null, filter: 'all' });
        void this.load();
      },
      print: () => window.print(),
    };
  }
}

// ---- 보고서 --------------------------------------------------------------------------------
type Period = 'day' | 'week' | 'month';
const tone = (v: number | null) =>
  v == null ? { bg: '#0b0e12', fg: C.dim } : v >= 100 ? { bg: SOFT.danger, fg: C.danger } : v >= 80 ? { bg: SOFT.caution, fg: C.caution } : v >= 60 ? { bg: C.seg2, fg: C.ink } : v >= 40 ? { bg: C.seg, fg: C.ink } : { bg: C.chip, fg: C.muted };

/** The last four Monday–Sunday weeks before this one (KST). */
function pastWeeks() {
  const now = new Date(Date.now() + 9 * 3600_000); // KST wall clock in UTC fields
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
  const lastSunday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (dow + 1) * 86_400_000;
  const label = (t: number) => `${new Date(t).getUTCMonth() + 1}월 ${new Date(t).getUTCDate()}일`;
  return Array.from({ length: 4 }, (_, i) => {
    const end = lastSunday - i * 7 * 86_400_000;
    const start = end - 6 * 86_400_000;
    return { end: new Date(end).toISOString().slice(0, 10), title: `주간 보고서 · ${label(start)} – ${label(end)}` };
  });
}

export class Reports extends AdminScreen<{ data: Report | null; period: Period; end: string | null; busy: boolean }> {
  state = { data: null as Report | null, period: 'week' as Period, end: null as string | null, busy: false };
  private printAfterLoad = false;

  mounted() {
    void this.load();
    void refreshPending();
  }
  loading() {
    return this.state.data === null;
  }
  private async load() {
    const { period, end } = this.state;
    this.setState({ busy: true });
    const data = await this.guard(api.report(this.site, period, end ?? undefined));
    if (!this.alive || period !== this.state.period || end !== this.state.end) return;
    this.setState({ data: data ?? this.state.data, busy: false });
    if (this.printAfterLoad) {
      this.printAfterLoad = false;
      setTimeout(() => window.print(), 300);
    }
  }
  private go(period: Period, end: string | null, print = false) {
    this.printAfterLoad = print;
    this.setState({ period, end });
    void this.load();
    if (end) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderVals() {
    const r = this.state.data;
    if (!r) return { nav: this.nav() };
    const { period, end } = this.state;
    const s = r.summary;
    const maxBar = Math.max(1, ...r.alertBars.map((b) => b.caution + b.danger));
    const unit = Math.min(30, 150 / maxBar);
    const delta = s.delta;
    const resp = s.avgResponseSec;
    return {
      nav: this.nav(),
      range: `${r.range}${end ? ' · 지난 보고서' : ''}`,
      periods: (
        [
          ['day', '일간'],
          ['week', '주간'],
          ['month', '월간'],
        ] as [Period, string][]
      ).map(([id, label]) => seg(label, !end && id === period, () => this.go(id, null))),
      print: () => window.print(),
      s: {
        avg: s.avg == null ? '–' : `${s.avg}%`,
        avgNote: delta == null ? `${r.prevLabel} 기록이 없어요` : delta < 0 ? `${r.prevLabel}보다 ${-delta}%p 낮아요` : delta > 0 ? `${r.prevLabel}보다 ${delta}%p 높아요` : `${r.prevLabel}와 같아요`,
        caution: s.caution,
        cautionFg: s.caution ? C.caution : C.ink,
        cautionNote: s.cautionNote || ' ',
        danger: s.danger,
        dangerFg: s.danger ? C.danger : C.ink,
        dangerNote: s.dangerNote,
        handled: `${s.handled}/${s.total}`,
        handledNote: !s.total ? '이 기간 알림이 없어요' : s.handled === s.total ? '모든 알림에 조치 기록' : `${s.total - s.handled}건 처리 대기`,
        hasResp: resp != null,
        noResp: resp == null,
        respMin: resp == null ? 0 : Math.floor(resp / 60),
        respSec: resp == null ? 0 : resp % 60,
      },
      columns: r.columns.map((c) => ({ label: c.label, fg: c.today ? C.ink : C.muted, fw: c.today ? 700 : 400 })),
      colCount: Math.max(1, r.columns.length),
      heat: r.heat.map((h) => {
        const top = Math.max(-1, ...h.cells.map((v) => v ?? -1));
        return { zone: h.zone, nameFg: top >= 100 ? C.danger : top >= 80 ? C.caution : C.ink, cells: h.cells.map((v) => ({ v: v == null ? '–' : v, ...tone(v) })) };
      }),
      alertBars: r.alertBars.map((b) => ({
        day: b.label,
        total: b.caution + b.danger,
        ch: Math.round(b.caution * unit),
        dh: Math.round(b.danger * unit),
        tc: b.today ? C.ink : C.muted,
        w: b.today ? 700 : 400,
      })),
      barsLabel: `기간별 알림. ${r.alertBars.map((b) => `${b.label} 주의 ${b.caution} 위험 ${b.danger}`).join(', ')}`,
      people: r.people.map((p) => ({
        id: p.id,
        n: p.name,
        z: p.zone,
        avg: p.avg,
        barW: Math.min(100, p.avg),
        barC: p.avg >= 100 ? C.danger : p.avg >= 80 ? C.caution : C.muted,
        max: p.max,
        maxFg: p.max >= 100 ? C.danger : p.max >= 80 ? C.caution : C.ink,
        days: `${p.cautionDays}일`,
        danger: `${p.danger}건`,
        dangerFg: p.danger ? C.danger : C.muted,
        rec: p.rec,
        recFg: p.rec === '–' ? C.dim : C.ink,
      })),
      peopleNote: `평균 누적 높은 순 · ${r.people.length}명`,
      noPeople: r.people.length === 0,
      archive: pastWeeks().map((w) => ({
        title: w.title,
        meta: w.end === end ? '지금 보고 있어요' : '월–일 · 노출 · 알림 · 작업자 요약',
        dl: `${w.title} 인쇄 또는 PDF 저장`,
        view: () => this.go('week', w.end),
        print: () => (w.end === end ? window.print() : this.go('week', w.end, true)),
      })),
    };
  }
}

// ---- 센서 ---------------------------------------------------------------------------------
type SensorFilter = 'all' | 'off' | 'free' | 'cal' | 'low';
type SensorsState = {
  data: SensorList | null;
  filter: SensorFilter;
  modal: boolean;
  form: { id: string; maker: string; model: string; items: string; cal: string };
  busy: boolean;
  error: string;
};
export class Sensors extends AdminScreen<SensorsState> {
  state: SensorsState = { data: null, filter: 'all', modal: false, form: { id: '', maker: '', model: '', items: 'PM10 · PM2.5 · CO · 온습도', cal: '' }, busy: false, error: '' };

  mounted() {
    this.poll(30_000, () => this.load(true));
    void refreshPending();
  }
  loading() {
    return this.state.data === null;
  }
  private async load(quiet = false) {
    const data = await this.guard(api.sensors(this.site), quiet && this.state.data !== null);
    if (data && this.alive) this.setState({ data });
  }
  private async submit() {
    const f = this.state.form;
    if (this.state.busy) return;
    if (!/^[A-Za-z0-9-]{4,32}$/.test(f.id.trim())) return this.setState({ error: '센서 ID는 영문·숫자·- 4~32자예요.' });
    this.setState({ busy: true, error: '' });
    try {
      await api.addSensor(this.site, { id: f.id.trim(), maker: f.maker.trim() || undefined, model: f.model.trim() || undefined, items: f.items.trim() || undefined, calibratedOn: f.cal || undefined });
      toast(`${f.id.trim().toUpperCase()} 센서를 등록했어요`);
      this.setState({ busy: false, modal: false });
      void this.load();
    } catch (e) {
      this.setState({ busy: false, error: errText(e) });
    }
  }

  renderVals() {
    const data = this.state.data;
    if (!data) return { nav: this.nav() };
    const { filter } = this.state;
    const c = data.counts;
    const list = data.sensors.filter((s) => filter === 'all' || (filter === 'cal' ? s.calDue : filter === 'low' ? (s.battery ?? 100) < 20 : s.kind === filter));
    // the worker's phone relays the sensor, so "gateways" are shown as zones
    const byZone = new Map<string, { count: number; up: number }>();
    for (const s of data.sensors) {
      if (!s.zone) continue;
      const z = byZone.get(s.zone) ?? { count: 0, up: 0 };
      z.count++;
      if (s.kind === 'on') z.up++;
      byZone.set(s.zone, z);
    }
    const zones = [...byZone].sort((a, b) => a[0].localeCompare(b[0], 'ko'));
    const assigned = data.sensors.filter((s) => s.kind !== 'free').length;
    const f = this.state.form;
    const setForm = (patch: Partial<SensorsState['form']>) => this.setState({ form: { ...this.state.form, ...patch }, error: '' });
    const label = { on: '연결됨', off: '연결 끊김', free: '예비' };
    return {
      nav: this.nav(),
      subtitle: `센서 ${c.total}대 · 앱 연결 ${c.on}대`,
      c,
      canEdit: session.canEdit(),
      openModal: () => {
        this.setState({ modal: true, error: '', form: { id: '', maker: '', model: '', items: 'PM10 · PM2.5 · CO · 온습도', cal: today() } });
        setTimeout(() => document.querySelector<HTMLInputElement>('#s-id')?.focus(), 60);
      },
      hasZones: zones.length > 0,
      zoneNote: `작업자 휴대폰이 센서 값을 중계해요 · 연결 ${c.on}/${assigned}`,
      gateways: zones.map(([zone, z], i) => {
        const r = z.count ? z.up / z.count : 0;
        return {
          id: `Z-${String(i + 1).padStart(2, '0')}`,
          zone,
          count: `${z.count}대`,
          up: `${z.up}대`,
          bar1: r > 0 ? C.ink : C.seg2,
          bar2: r >= 0.5 ? C.ink : C.seg2,
          bar3: r >= 1 ? C.ink : C.seg2,
          sig: `${zone} 센서 ${z.count}대 중 ${z.up}대 연결`,
        };
      }),
      filters: [
        seg(`전체 ${c.total}`, filter === 'all', () => this.setState({ filter: 'all' })),
        seg(`끊김 ${c.off}`, filter === 'off', () => this.setState({ filter: 'off' })),
        seg(`예비 ${c.free}`, filter === 'free', () => this.setState({ filter: 'free' })),
        seg(`교정 필요 ${c.cal}`, filter === 'cal', () => this.setState({ filter: 'cal' })),
        seg(`배터리 낮음 ${c.low}`, filter === 'low', () => this.setState({ filter: 'low' })),
      ],
      rows: list.map((s) => {
        const cal = s.calDue && s.kind !== 'off';
        const on = s.kind === 'on';
        return {
          id: s.id,
          maker: s.maker,
          items: s.items,
          who: s.who,
          whoFg: s.kind === 'free' ? C.muted : C.ink,
          batW: s.battery ?? 0,
          batText: s.battery == null ? '–' : `${s.battery}%`,
          batC: (s.battery ?? 100) < 20 ? C.muted : C.ink,
          last: s.last,
          cal: s.calibrated,
          calFg: s.calDue ? C.caution : C.muted,
          st: cal ? '교정 필요' : label[s.kind],
          stFg: on || cal ? C.ink : C.muted,
          dot: on ? C.ink : cal ? C.muted : 'transparent',
          dotBd: on ? C.ink : cal ? C.muted : C.faint,
        };
      }),
      empty: list.length === 0,
      emptyText: data.sensors.length ? '이 조건에 맞는 센서가 없어요' : '등록된 센서가 없어요 · 센서 등록을 눌러 추가해 주세요',
      modal: this.state.modal,
      closeModal: () => this.setState({ modal: false }),
      form: f,
      onId: (ev: Event) => setForm({ id: inputValue(ev) }),
      onMaker: (ev: Event) => setForm({ maker: inputValue(ev) }),
      onModel: (ev: Event) => setForm({ model: inputValue(ev) }),
      onItems: (ev: Event) => setForm({ items: inputValue(ev) }),
      onCal: (ev: Event) => setForm({ cal: inputValue(ev) }),
      m: { error: this.state.error, busy: this.state.busy, opacity: this.state.busy ? 0.6 : 1, label: this.state.busy ? '등록하는 중…' : '등록', submit: () => void this.submit() },
    };
  }
}

// ---- 설정 ---------------------------------------------------------------------------------
type Form = { name: string; facility: string; address: string; pm10: string; pm25: string; co: string };
type SettingsState = {
  data: Settings | null;
  f: Form;
  rules: Rules;
  base: { f: Form; rules: Rules } | null;
  saving: boolean;
  saveError: string;
  section: string;
  inviteOpen: boolean;
  inv: { username: string; name: string; title: string; role: 'admin' | 'viewer'; password: string };
  passwordOpen: boolean;
  pw: { current: string; next: string; again: string };
  busy: boolean;
  error: string;
  copied: boolean;
};
const RULES: { key: keyof Rules; tag: string; label: string; hint: string; locked?: boolean }[] = [
  { key: 'cApp', tag: '주의', label: '작업자 앱 알림', hint: '본인에게 진동과 화면 알림' },
  { key: 'cAdmin', tag: '주의', label: '관리자 알림', hint: '관제 홈과 알림 탭에 표시' },
  { key: 'dEvac', tag: '위험', label: '자동 대피 알림', hint: '해당 작업자에게 바로 · 끌 수 없어요', locked: true },
  { key: 'advice', tag: '권고', label: '교대·순환 권고', hint: '누적 80%를 넘으면 알림 탭에 권고를 남겨요' },
  { key: 'sensor', tag: '센서', label: '연결 끊김 알림', hint: '60초 이상 수신이 없으면' },
];
const TAGS: Record<string, [string, string]> = { 주의: [SOFT.caution, C.caution], 위험: [SOFT.danger, C.danger], 권고: [C.chip, C.muted], 센서: [C.chip, C.muted] };
const ROLE_LABEL = { owner: '소유자', admin: '관리자', viewer: '보기 전용' } as const;
const toForm = (s: Settings): Form => ({ name: s.site.name, facility: s.site.facility, address: s.site.address, pm10: String(s.limits.pm10), pm25: String(s.limits.pm25), co: String(s.limits.co) });

export class SettingsScreen extends AdminScreen<SettingsState> {
  state: SettingsState = {
    data: null,
    f: { name: '', facility: '', address: '', pm10: '', pm25: '', co: '' },
    rules: { cApp: true, cAdmin: true, dEvac: true, advice: true, sensor: true },
    base: null,
    saving: false,
    saveError: '',
    section: 'site',
    inviteOpen: false,
    inv: { username: '', name: '', title: '', role: 'admin', password: '' },
    passwordOpen: false,
    pw: { current: '', next: '', again: '' },
    busy: false,
    error: '',
    copied: false,
  };

  mounted() {
    void this.load().then(() => {
      if (location.hash.includes('?pw') || session.state.admin?.mustChangePassword) this.openPassword();
    });
    void refreshPending();
  }
  loading() {
    return this.state.data === null;
  }
  private async load() {
    const data = await this.guard(api.settings(this.site));
    if (!data || !this.alive) return;
    const f = toForm(data);
    this.setState({ data, f, rules: data.rules, base: { f, rules: data.rules } });
  }
  private dirty() {
    const { base, f, rules } = this.state;
    return !!base && (JSON.stringify(base.f) !== JSON.stringify(f) || JSON.stringify(base.rules) !== JSON.stringify(rules));
  }
  private async save() {
    const { f, rules, base, saving } = this.state;
    if (saving || !base || this.readOnly()) return;
    const num = (v: string) => Number(v.replace(/[^\d.]/g, ''));
    const limits = { pm10: num(f.pm10), pm25: num(f.pm25), co: num(f.co) };
    if (!f.name.trim()) return this.setState({ saveError: '현장 이름을 적어 주세요.' });
    if (Object.values(limits).some((v) => !Number.isFinite(v) || v <= 0)) return this.setState({ saveError: '권고치는 0보다 큰 숫자로 적어 주세요.' });
    this.setState({ saving: true, saveError: '' });
    try {
      await api.saveSettings(this.site, {
        site: { name: f.name.trim(), facility: f.facility.trim(), address: f.address.trim() },
        limits,
        rules: Object.fromEntries(Object.entries(rules).filter(([k]) => k !== 'dEvac')),
      });
      if (f.name.trim() !== session.state.siteName) session.pickSite(this.site, f.name.trim());
      toast('설정을 저장했어요');
      this.setState({ saving: false });
      void this.load();
    } catch (e) {
      this.setState({ saving: false, saveError: errText(e) });
    }
  }
  openPasswordDialog() {
    if (this.state.data) this.openPassword();
  }
  private openPassword() {
    this.setState({ passwordOpen: true, inviteOpen: false, pw: { current: '', next: '', again: '' }, error: '', busy: false });
    setTimeout(() => document.querySelector<HTMLInputElement>('#p-cur')?.focus(), 60);
  }
  private async changePassword() {
    const { pw, busy } = this.state;
    if (busy) return;
    if (!pw.current) return this.setState({ error: '지금 비밀번호를 적어 주세요.' });
    if (pw.next.length < 8) return this.setState({ error: '새 비밀번호는 8자 이상이에요.' });
    if (pw.next !== pw.again) return this.setState({ error: '새 비밀번호가 서로 달라요.' });
    if (pw.next === pw.current) return this.setState({ error: '지금과 다른 비밀번호를 정해 주세요.' });
    this.setState({ busy: true, error: '' });
    try {
      await api.changePassword(pw.current, pw.next);
      const a = session.state.admin;
      if (a) session.set({ admin: { ...a, mustChangePassword: false } });
      this.setState({ busy: false, passwordOpen: false });
      toast('비밀번호를 바꿨어요');
    } catch (e) {
      this.setState({ busy: false, error: errText(e) });
    }
  }
  private async createAdmin() {
    const { inv, busy } = this.state;
    if (busy) return;
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(inv.username.trim())) return this.setState({ error: '아이디는 영문·숫자 3자 이상이에요.' });
    if (!inv.name.trim()) return this.setState({ error: '이름을 적어 주세요.' });
    if (inv.password.length < 8) return this.setState({ error: '임시 비밀번호는 8자 이상이에요.' });
    this.setState({ busy: true, error: '' });
    try {
      await api.addAdmin({ username: inv.username.trim(), name: inv.name.trim(), title: inv.title.trim() || undefined, role: inv.role, password: inv.password });
      toast(`${inv.username.trim()} 계정을 만들었어요 · 임시 비밀번호를 전달해 주세요`, 4000);
      this.setState({ busy: false, inviteOpen: false });
      void this.load();
    } catch (e) {
      this.setState({ busy: false, error: errText(e) });
    }
  }
  private async toggleMember(id: number, name: string, active: boolean) {
    if (!confirm(active ? `${name} 님 계정을 다시 쓸 수 있게 할까요?` : `${name} 님 계정을 사용 중지할까요?\n바로 로그아웃돼요.`)) return;
    if (await this.guard(api.patchAdmin(id, { active }))) {
      toast(active ? '계정을 다시 켰어요' : '계정을 사용 중지했어요');
      void this.load();
    }
  }
  private async resetMember(id: number, name: string) {
    if (!confirm(`${name} 님에게 임시 비밀번호를 만들어 줄까요?\n지금 로그인된 곳에서는 로그아웃돼요.`)) return;
    const password = tempPassword();
    if (await this.guard(api.patchAdmin(id, { password }))) {
      const copied = await copyText(password);
      toast(`임시 비밀번호 ${password}${copied ? ' · 복사했어요' : ''} · 처음 로그인하면 바꾸게 돼요`, 10_000);
    }
  }

  renderVals() {
    const data = this.state.data;
    if (!data) return { nav: this.nav() };
    const s = this.state;
    const canEdit = session.canEdit();
    const isOwner = session.isOwner();
    const clean = !this.dirty();
    const setF = (patch: Partial<Form>) => this.setState({ f: { ...this.state.f, ...patch }, saveError: '' });
    const setInv = (patch: Partial<SettingsState['inv']>) => this.setState({ inv: { ...this.state.inv, ...patch }, error: '' });
    const setPw = (patch: Partial<SettingsState['pw']>) => this.setState({ pw: { ...this.state.pw, ...patch }, error: '' });
    const ig = data.integrations;
    const state = (on: boolean, yes: string, no: string) => ({ label: on ? yes : no, dot: on ? C.ink : 'transparent', fg: on ? C.ink : C.muted });
    return {
      nav: this.nav(),
      siteName: data.site.name,
      sections: (
        [
          ['site', '현장'],
          ['limits', '노출 기준'],
          ['rules', '알림 규칙'],
          ['members', '관리자'],
          ['integrations', '연동'],
        ] as const
      ).map(([id, label]) => ({
        label,
        bg: s.section === id ? C.panel : 'transparent',
        fg: s.section === id ? C.ink : C.muted,
        fw: s.section === id ? 600 : 400,
        go: () => {
          this.setState({ section: id });
          document.getElementById(`s-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      })),
      f: s.f,
      ro: !canEdit,
      onName: (ev: Event) => setF({ name: inputValue(ev) }),
      onFacility: (ev: Event) => setF({ facility: inputValue(ev) }),
      onAddress: (ev: Event) => setF({ address: inputValue(ev) }),
      onPm10: (ev: Event) => setF({ pm10: inputValue(ev) }),
      onPm25: (ev: Event) => setF({ pm25: inputValue(ev) }),
      onCo: (ev: Event) => setF({ co: inputValue(ev) }),
      shifts: data.site.shifts.map((h) => ({ name: h.name, time: `${h.start}–${h.end}` })),
      noShifts: data.site.shifts.length === 0,
      zonesLabel: `구역 ${data.site.zones}개 · 휴게 구역 ${data.site.rest}개`,
      rules: RULES.map((d, i) => {
        const on = d.locked ? true : s.rules[d.key];
        const locked = !!d.locked || !canEdit;
        return {
          id: `rule-${i}`,
          tag: d.tag,
          label: d.label,
          hint: d.hint,
          on,
          locked,
          tagBg: TAGS[d.tag][0],
          tagFg: TAGS[d.tag][1],
          track: on ? C.ink : C.seg,
          knob: on ? '#0b0e12' : C.muted,
          left: on ? 24 : 4,
          cursor: locked ? 'not-allowed' : 'pointer',
          opacity: locked ? 0.6 : 1,
          flip: () => !locked && this.setState({ rules: { ...this.state.rules, [d.key]: !on }, saveError: '' }),
        };
      }),
      members: data.members.map((m) => ({
        initial: m.name.slice(0, 1),
        name: m.name,
        tag: m.me ? '· 나' : m.active ? '' : '· 사용 중지',
        sub: [m.username, m.title].filter(Boolean).join(' · '),
        roleLabel: ROLE_LABEL[m.role],
        roleFg: m.role === 'viewer' ? C.muted : C.ink,
        isMe: m.me,
        canToggle: isOwner && !m.me && m.role !== 'owner',
        toggle: () => void this.toggleMember(m.id, m.name, !m.active),
        toggleLabel: m.active ? '사용 중지' : '다시 사용',
        reset: () => void this.resetMember(m.id, m.name),
        opacity: m.active ? 1 : 0.55,
      })),
      isOwner,
      openInvite: () => {
        this.setState({ inviteOpen: true, passwordOpen: false, inv: { username: '', name: '', title: '', role: 'admin', password: tempPassword() }, error: '', busy: false, copied: false });
        setTimeout(() => document.querySelector<HTMLInputElement>('#a-user')?.focus(), 60);
      },
      openPassword: () => this.openPassword(),
      integrations: [
        { name: '작업자 앱', sub: `센서 ${ig.app.n}대 배정 · 최근 10분 ${ig.app.online}대 수신`, ...state(ig.app.online > 0, '수신 중', '대기') },
        { name: '푸시 알림 · APNs', sub: ig.push ? '교대 지시와 공지를 앱으로 보내요' : 'Apple 푸시 키를 넣으면 켜져요', ...state(ig.push, '설정됨', '설정 전') },
        { name: '관제 웹훅', sub: ig.webhook ? '위험·SOS를 메신저로 보내요' : 'Dooray·Slack 웹훅 주소를 넣으면 켜져요', ...state(ig.webhook, '설정됨', '설정 전') },
      ],
      canEdit,
      clean,
      dimClean: clean ? 0.5 : 1,
      revert: () => s.base && this.setState({ f: s.base.f, rules: s.base.rules, saveError: '' }),
      save: () => void this.save(),
      saveLabel: s.saving ? '저장하는 중…' : '변경 사항 저장',
      saveError: s.saveError,
      // dialogs
      closeModal: () => this.setState({ inviteOpen: false, passwordOpen: false }),
      inviteOpen: s.inviteOpen,
      inv: s.inv,
      onInvUser: (ev: Event) => setInv({ username: inputValue(ev) }),
      onInvName: (ev: Event) => setInv({ name: inputValue(ev) }),
      onInvTitle: (ev: Event) => setInv({ title: inputValue(ev) }),
      onInvPass: (ev: Event) => setInv({ password: inputValue(ev) }),
      roleChips: [chip('관리자 · 편집 가능', s.inv.role === 'admin', () => setInv({ role: 'admin' })), chip('보기 전용', s.inv.role === 'viewer', () => setInv({ role: 'viewer' }))],
      copyLabel: s.copied ? '복사했어요' : '복사',
      copyPass: async () => {
        await copyText(s.inv.password);
        this.setState({ copied: true });
        this.later(1600, () => this.alive && this.setState({ copied: false }));
      },
      passwordOpen: s.passwordOpen,
      pw: s.pw,
      pwHint: session.state.admin?.mustChangePassword ? '처음 받은 비밀번호를 바꿔 주세요' : '바꾸면 다른 브라우저에서는 로그아웃돼요',
      onPwCur: (ev: Event) => setPw({ current: inputValue(ev) }),
      onPwNext: (ev: Event) => setPw({ next: inputValue(ev) }),
      onPwAgain: (ev: Event) => setPw({ again: inputValue(ev) }),
      onPwKey: (ev: KeyboardEvent) => ev.key === 'Enter' && void this.changePassword(),
      m: {
        error: s.error,
        busy: s.busy,
        opacity: s.busy ? 0.6 : 1,
        label: s.busy ? '저장하는 중…' : s.passwordOpen ? '비밀번호 바꾸기' : '계정 만들기',
        submit: () => void (s.passwordOpen ? this.changePassword() : this.createAdmin()),
      },
    };
  }
}

