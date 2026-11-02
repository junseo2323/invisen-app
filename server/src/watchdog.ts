// Background checks for the dashboard, every 30 s:
// - sensor stopped sending for 60 s → "센서 연결 끊김" incident (auto-resolves when data returns)
// - worker's cumulative exposure today reached 80% → shift advice (once per worker per day)
import { one, q } from './db.js';
import { autoResolve, createAlert, siteRules } from './alerts.js';
import { siteWorkers } from './admin-data.js';
import { dayStart } from './exposure.js';
import { tz } from './queries.js';

const hms = (d: Date) => new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(d);

export async function checkSensors() {
  // came back
  const back = await q<{ dedup_key: string }>(
    `select a.dedup_key from alerts a join sensors s on a.dedup_key = 'sensor:' || s.id
      where a.type = 'sensor' and a.status in ('open', 'acked') and s.last_seen_at > a.created_at and s.last_seen_at > now() - interval '60 seconds'`,
  );
  for (const b of back) await autoResolve(b.dedup_key, '자동 재연결');
  // went quiet (only sensors that sent something in the last 8 hours, i.e. during a shift)
  const quiet = await q<{ id: string; site_id: number; battery: number | null; last_seen_at: Date; worker_id: number; name: string; zone: string | null }>(
    `select s.id, w.site_id, s.battery, s.last_seen_at, w.id as worker_id, w.name, z.name as zone
       from sensors s join workers w on w.id = s.worker_id left join zones z on z.id = w.current_zone_id
      where w.active and not w.is_demo
        and s.last_seen_at between now() - interval '8 hours' and now() - interval '60 seconds'`,
  );
  for (const s of quiet) {
    if (!(await siteRules(s.site_id)).sensor) continue;
    const low = (s.battery ?? 100) < 10;
    await createAlert({
      siteId: s.site_id,
      type: 'sensor',
      title: `${s.name} 님 센서 연결이 끊겼어요`,
      sub: `마지막 위치 ${s.zone ?? '–'}${s.battery != null ? ` · 배터리 ${s.battery}%` : ''}`,
      metrics: [['센서', s.id], ['마지막 수신', hms(s.last_seen_at)], ['배터리', s.battery != null ? `${s.battery}%` : '–']],
      rec: low ? '배터리가 다 됐어요. 예비 센서로 바꿔 주세요.' : '작업자에게 센서 착용과 앱 실행을 확인해 주세요.',
      workerIds: [s.worker_id],
      timeline: ['60초 넘게 수신 없음', '관리자 알림'],
      dedupKey: `sensor:${s.id}`,
    });
  }
}

export async function checkAdvice() {
  const sites = await q<{ id: number }>(`select id from sites where status = 'active'`);
  const today = dayStart(Date.now(), tz());
  const day = new Date(today).toISOString().slice(0, 10);
  for (const site of sites) {
    if (!(await siteRules(site.id)).advice) continue;
    for (const w of await siteWorkers(site.id)) {
      if (w.cum < 80) continue;
      const key = `advice:${w.id}:${day}`;
      if (await one('select 1 from alerts where dedup_key = $1', [key])) continue;
      await createAlert({
        siteId: site.id,
        type: 'advice',
        title: `${w.name} 님 누적 노출량 ${w.cum}%`,
        sub: `${w.zone ?? '구역 미지정'} · 오늘 권고치의 80%를 넘었어요`,
        metrics: [['오늘 누적', `${w.cum}%`], ['지금 PM10', w.pm10 != null ? String(w.pm10) : '–'], ['구역', w.zone ?? '–']],
        rec: '작업 교대를 권해요. 노출이 낮은 구역이나 휴게 구역으로 옮기면 오늘 누적이 더 오르지 않아요.',
        workerIds: [w.id],
        timeline: ['누적 80% 초과 감지', '교대 권고 생성'],
        dedupKey: key,
      });
    }
  }
}

let ticks = 0;
export function startWatchdog(log: (e: unknown) => void) {
  const run = async () => {
    try {
      await checkSensors();
      if (ticks++ % 4 === 0) await checkAdvice(); // every 2 minutes
    } catch (e) {
      log(e);
    }
  };
  const t = setInterval(run, 30_000);
  t.unref();
  void run();
  return () => clearInterval(t);
}
