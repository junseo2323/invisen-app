// Screen state, ported from each artboard's renderVals() in design/*.dc.html.
// Values are the design's sample data until the eney.cloud API is wired in.
import { Screen } from '../dc';
import { haptics } from '../native';
import { prefs } from '../store';

export class LoginSensor extends Screen<{ picked?: string }> {
  renderVals() {
    const picked = this.state.picked || 'IVS-P10-0142';
    const list = [
      { id: 'IVS-P10-0142', meta: '가까워요 · 배터리 92%' },
      { id: 'IVS-P10-0157', meta: '멀어요 · 배터리 64%' },
    ];
    const sensors = list.map((s) => {
      const selected = s.id === picked;
      return {
        ...s,
        selected,
        bg: selected ? '#0d2e35' : '#13171c',
        border: selected ? '#2bd8f0' : '#13171c',
        boxBg: selected ? '#2bd8f0' : 'transparent',
        boxBd: selected ? '#2bd8f0' : '#5f6975',
        checkColor: selected ? '#0b0e12' : 'transparent',
        pick: () => this.setState({ picked: s.id }),
      };
    });
    return { sensors };
  }
}

export class Site extends Screen<{ sel?: string | null }> {
  renderVals() {
    const sel = this.state.sel || null;
    const raw = [
      { id: 'ldy', name: '이도윤', initial: '이', zone: '3구역', dist: '47 m', x: 19.9, y: 49.6 },
      { id: 'csy', name: '최서연', initial: '최', zone: '3구역', dist: '93 m', x: 11.9, y: 63.1 },
      { id: 'osr', name: '오세린', initial: '오', zone: '4구역', dist: '163 m', x: 44.1, y: 39.8 },
      { id: 'hjm', name: '한지민', initial: '한', zone: '휴게실 B', dist: '237 m', x: 57.0, y: 72.4 },
      { id: 'jwj', name: '정우진', initial: '정', zone: '5구역', dist: '299 m', x: 70.0, y: 52.1, caution: true },
      { id: 'phn', name: '박하늘', initial: '박', zone: '5구역', dist: '369 m', x: 79.3, y: 41.6, caution: true },
      { id: 'kto', name: '김태오', initial: '김', zone: '5구역', dist: '405 m', x: 86.5, y: 58.5, caution: true },
    ];
    const team = raw.map((t) => ({
      ...t,
      caution: !!t.caution,
      sel: t.id === sel,
      rowBg: t.id === sel ? '#0d2e35' : 'transparent',
      pick: () => this.setState({ sel: t.id === sel ? null : t.id }),
    }));
    return { team };
  }
}

export class Exposure extends Screen {
  renderVals() {
    const values = [20, 26, 30, 34, 41, 47, 55, 62, 88, 112, 15, 14, 33, 36, 38];
    const bars = values.map((v, i) => ({
      h: Math.round((v / 120) * 160 * 10) / 10,
      c: v >= 100 ? '#ff5a4a' : v >= 80 ? '#ffbe1a' : i === values.length - 1 ? '#e3e7eb' : '#3f4852',
      now: i === values.length - 1,
    }));
    const days: { day: string; v: number | null; today?: boolean }[] = [
      { day: '화', v: 36 }, { day: '수', v: 44 }, { day: '목', v: 81 },
      { day: '금', v: 39 }, { day: '토', v: null }, { day: '일', v: 38 },
      { day: '오늘', v: 41, today: true },
    ];
    const week = days.map((d) => ({
      day: d.day,
      v: d.v == null ? '–' : d.v + '%',
      h: d.v == null ? 2 : Math.round(d.v * 0.9),
      c: d.v == null ? '#2c333b' : d.v >= 100 ? '#ff5a4a' : d.v >= 80 ? '#ffbe1a' : d.today ? '#e3e7eb' : '#3f4852',
      tc: d.today ? '#e3e7eb' : '#a9b1bb',
      w: d.today ? 700 : 400,
    }));
    return { bars, week };
  }
}

export class Log extends Screen<{ filter?: string }> {
  renderVals() {
    const filter = this.state.filter || 'all';
    const defs = [
      { id: 'all', label: '전체' },
      { id: 'alert', label: '알림' },
      { id: 'move', label: '이동' },
      { id: 'sensor', label: '센서' },
    ];
    const filters = defs.map((d) => {
      const on = d.id === filter;
      return {
        label: d.label,
        on,
        bg: on ? '#2c333b' : 'transparent',
        fg: on ? '#e3e7eb' : '#a9b1bb',
        fw: on ? 700 : 400,
        pick: () => this.setState({ filter: d.id }),
      };
    });
    const log: { time: string; type: string; state?: 'danger' | 'caution'; title: string; detail: string }[] = [
      { time: '14:05', type: 'move', title: '3구역으로 이동', detail: '휴게실 → 3구역' },
      { time: '12:58', type: 'sensor', title: '센서 다시 연결', detail: '42초 동안 끊겼어요' },
      { time: '12:02', type: 'move', title: '휴게실로 이동', detail: '5구역 → 휴게실' },
      { time: '11:31', type: 'alert', title: '위험 알림 확인', detail: '5구역을 벗어났어요' },
      { time: '11:24', type: 'alert', state: 'danger', title: '5구역 PM10 112 µg/m³', detail: '권고치 112% · 관리자에게 전달됐어요' },
      { time: '11:02', type: 'alert', state: 'caution', title: '5구역 PM10 88 µg/m³', detail: '권고치 88% · 마스크를 써주세요' },
      { time: '09:48', type: 'move', title: '5구역으로 이동', detail: '3구역 → 5구역' },
      { time: '07:02', type: 'sensor', title: '측정 시작', detail: 'IVS-P10-0142' },
    ];
    const off = '#3f4852';
    const items = log
      .filter((it) => filter === 'all' || it.type === filter)
      .map((it) => {
        const danger = it.state === 'danger';
        const caution = it.state === 'caution';
        return {
          time: it.time,
          title: it.title,
          detail: it.detail,
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
    return { filters, items };
  }
}

export class More extends Screen<Record<string, boolean>> {
  state = prefs.load();

  renderVals() {
    const st = this.state;
    const defs = [
      { id: 'tg-vibe', key: 'vibe', label: '진동 알림', def: true },
      { id: 'tg-big', key: 'big', label: '큰 글씨', def: false },
      { id: 'tg-light', key: 'light', label: '밝은 화면', def: false },
    ];
    const toggles = defs.map((d) => {
      const on = st[d.key] == null ? d.def : st[d.key];
      return {
        id: d.id,
        label: d.label,
        on,
        track: on ? '#e3e7eb' : '#2c333b',
        knob: on ? '#0b0e12' : '#a9b1bb',
        left: on ? 24 : 4,
        flip: () => {
          this.setState({ [d.key]: !on });
          prefs.save(this.state);
        },
      };
    });
    return { toggles };
  }
}

type SosState = { p: number; sent: boolean; flash: boolean; calm: boolean };

export class Sos extends Screen<SosState> {
  state: SosState = { p: 0, sent: false, flash: false, calm: false };
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
    if (reduce) {
      this.setState({ flash: true, calm: true });
      return;
    }
    let n = 0;
    this.setState({ flash: true, calm: false });
    this.flashTimer = window.setInterval(() => {
      n += 1;
      if (n >= 12) {
        clearInterval(this.flashTimer);
        this.setState({ flash: false });
        return;
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

  renderVals() {
    const { p, sent, flash, calm } = this.state;
    const start = (ev: Event) => {
      ev.preventDefault();
      if (this.state.sent) return;
      clearInterval(this.timer);
      this.beep(880, 0.08, 0.2);
      haptics.tick();
      this.timer = window.setInterval(() => {
        const prev = this.state.p;
        const np = Math.min(1, prev + 0.05);
        if (np >= 1) {
          clearInterval(this.timer);
          this.setState({ p: 1, sent: true });
          this.alarm();
          // TODO: eney.cloud API — send SOS with worker id, zone, PM10, location.
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
      if (this.state.sent) return;
      clearInterval(this.timer);
      this.setState({ p: 0 });
    };
    const reset = () => {
      this.stopAll();
      this.setState({ p: 0, sent: false, flash: false, calm: false });
    };
    const secs = Math.max(1, Math.ceil(3 - p * 3));
    return {
      headline: sent ? '관제실에\n알렸어요' : '3초 동안\n꾹 눌러주세요',
      dash: sent ? 0 : Math.round((100 - p * 100) * 10) / 10,
      big: sent ? 'SENT' : 'SOS',
      plate: sent ? '14:32 · 반장 · 관제실' : 'HOLD ' + secs + 'S',
      sent,
      flashOpacity: flash ? (calm ? 0.18 : 0.42) : 0,
      callBg: sent ? '#e3e7eb' : '#1c2127',
      callFg: sent ? '#0b0e12' : '#e3e7eb',
      start,
      stop,
      reset,
    };
  }
}
