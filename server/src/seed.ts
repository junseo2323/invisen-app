// Seeds the design's sample site/workers/sensors.  npm run seed [-- --demo]
//   --me    see below
//   --demo  also generates today's readings/events for 김현수 and recent readings for
//           the team, so every screen has data (local development / showcase only).
// Phone numbers other than 김현수's (from the design) are placeholders (010-0000-00xx).
import { pool, q, one, tx } from './db.js';
import { migrate } from './migrate.js';
import { config } from './config.js';
import { dayStart } from './exposure.js';
import { issueInvite } from './invites.js';
import { hhmmss } from './alerts.js';

const demo = process.argv.includes('--demo');
// --me "이름:01012345678"  → that person takes 김현수's place (so you can log in on a real server)
const meArg = process.argv[process.argv.indexOf('--me') + 1];
const [meName, mePhone] = process.argv.includes('--me') && meArg ? meArg.split(':') : ['김현수', '01024813307'];
const MIN = 60_000;

async function main() {
  await migrate();
  if (await one('select 1 from sites limit 1')) {
    console.log('seed: data already present, skipping');
    return;
  }
  await tx(async (c) => {
    const site = (await c.query<{ id: number }>(
      `insert into sites (name, facility, address, control_room_phone, map_width_m, map_height_m, shifts)
       values ('인천공항 T1 BHS', '수하물 처리 시설', '인천광역시 중구 공항로 272', '0200000000', 600, 300, $1) returning id`,
      [JSON.stringify([
        { name: '주간 A조', start: '07:00', end: '15:00' },
        { name: '주간 B조', start: '15:00', end: '23:00' },
        { name: '야간 C조', start: '23:00', end: '07:00' },
      ])],
    )).rows[0].id;
    const zone = async (code: string, name: string, rest = false, refuge?: [string, number]) =>
      (await c.query<{ id: number }>(
        `insert into zones (site_id, code, name, is_rest, refuge_name, refuge_distance_m) values ($1, $2, $3, $4, $5, $6) returning id`,
        [site, code, name, rest, refuge?.[0] ?? null, refuge?.[1] ?? null],
      )).rows[0].id;
    const z3 = await zone('3', '3구역', false, ['휴게실 B', 40]);
    const z4 = await zone('4', '4구역', false, ['휴게실 B', 120]);
    const z5 = await zone('5', '5구역', false, ['휴게실 B', 160]);
    const zr = await zone('rest-b', '휴게실 B', true);

    const worker = async (w: { no: string; name: string; phone: string; role?: string; manager?: number; zone: number; zones?: number[]; spot?: string; x: number; y: number; level?: string }) =>
      (await c.query<{ id: number }>(
        `insert into workers (site_id, employee_no, name, phone, company, team, role, manager_id, shift_name, shift_start, shift_end,
                              assigned_zone_ids, current_zone_id, current_spot, map_x, map_y, position_at, alert_level)
         values ($1, $2, $3, $4, '협력사 A', '수하물 처리팀', $5, $6, '주간 A조', '07:00', '15:00', $7, $8, $9, $10, $11, now(), $12) returning id`,
        [site, w.no, w.name, w.phone, w.role ?? 'worker', w.manager ?? null, w.zones ?? [w.zone], w.zone, w.spot ?? null, w.x, w.y, w.level ?? 'safe'],
      )).rows[0].id;

    const boss = await worker({ no: 'M-03-0001', name: '박정민', phone: '01000000001', role: 'manager', zone: z3, x: 30, y: 40 });
    const me = await worker({ no: 'W-03-0218', name: meName, phone: mePhone.replace(/\D/g, ''), manager: boss, zone: z3, zones: [z3, z5], spot: 'C-12', x: 27.5, y: 50 });
    const team = [
      ['W-03-0221', '이도윤', z3, 19.9, 49.6, 'safe'],
      ['W-03-0224', '최서연', z3, 11.9, 63.1, 'safe'],
      ['W-03-0230', '오세린', z4, 44.1, 39.8, 'safe'],
      ['W-03-0233', '한지민', zr, 57.0, 72.4, 'safe'],
      ['W-03-0240', '정우진', z5, 70.0, 52.1, 'caution'],
      ['W-03-0241', '박하늘', z5, 79.3, 41.6, 'caution'],
      ['W-03-0247', '김태오', z5, 86.5, 58.5, 'caution'],
    ] as const;
    const teamIds: number[] = [];
    for (const [i, [no, name, z, x, y, level]] of team.entries()) {
      teamIds.push(await worker({ no, name, phone: `010000000${10 + i}`, manager: boss, zone: z, x, y, level }));
    }

    await c.query(
      `insert into sensors (id, site_id, maker, model, items, battery, firmware, calibrated_on) values
         ('IVS-P10-0142', $1, '파트너 A', 'W-3', 'PM10 · PM2.5 · CO · 온습도', 92, 'v2.1.4', '2026-10-12'),
         ('IVS-P10-0157', $1, '파트너 A', 'W-3', 'PM10 · PM2.5 · CO · 온습도', 64, 'v2.1.4', '2026-10-12')`,
      [site],
    );
    await c.query(
      `insert into notices (site_id, title, detail) values ($1, '5구역 집진기를 점검하고 있어요', '14:00–16:00 · 관제실')`,
      [site],
    );

    if (!demo) return;

    // ---- demo readings -------------------------------------------------------
    await c.query(`update sensors set worker_id = $1, last_seen_at = now(), battery = 76 where id = 'IVS-P10-0142'`, [me]);
    const now = Date.now();
    const today = dayStart(now, config.tzOffsetMin);
    const at = (h: number, m: number) => today + (h * 60 + m) * MIN;

    // today, 30-minute profile from the design (07:00 →), one reading per minute
    const profile = [20, 26, 30, 34, 41, 47, 55, 62, 88, 112, 15, 14, 33, 36, 38];
    const zoneAt = (t: number) => (t < at(9, 48) ? z3 : t < at(12, 2) ? z5 : t < at(14, 5) ? zr : z3);
    const rows: [number, string, number, number, number, number | null, number | null][] = [];
    for (let t = at(7, 2); t <= now; t += MIN) {
      if (t >= at(12, 57) && t < at(12, 58)) continue; // the design's 42-second dropout
      const i = Math.min(profile.length - 1, Math.floor((t - at(7, 0)) / (30 * MIN)));
      const v = Math.max(5, profile[i] + Math.sin(t / 97_000) * 3);
      rows.push([me, 'IVS-P10-0142', zoneAt(t), t, v, v * 0.55, 8 + Math.sin(t / 300_000) * 3]);
    }
    // previous six days (constant level for an 8h shift → exposure ≈ that %)
    const week = [36, 44, 81, 39, null, 38];
    week.forEach((v, i) => {
      if (v == null) return;
      const d = today - (6 - i) * 86_400_000;
      for (let t = d + 7 * 60 * MIN; t < d + 15 * 60 * MIN; t += 5 * MIN) rows.push([me, 'IVS-P10-0142', z3, t, v, v * 0.55, 8]);
    });
    // team: last 10 minutes
    for (const [i, id] of teamIds.entries()) {
      const sid = `IVS-P10-02${String(i).padStart(2, '0')}`;
      await c.query(
        `insert into sensors (id, site_id, worker_id, maker, model, items, battery, firmware, calibrated_on, last_seen_at)
         values ($1, $2, $3, '파트너 B', 'BX-2', 'PM10 · PM2.5 · 온습도', $4, 'v2.1.4', '2026-08-14', now())`,
        [sid, site, id, 55 + i * 5],
      );
      const z = team[i][2];
      const base = z === z5 ? 86 : z === zr ? 15 : 40;
      for (let t = now - 10 * MIN; t <= now; t += MIN) rows.push([id, sid, z, t, base + (i % 3), null, null]);
    }
    for (let k = 0; k < rows.length; k += 1000) {
      const chunk = rows.slice(k, k + 1000).filter((r) => r[3] <= now);
      await c.query(
        `insert into readings (worker_id, sensor_id, zone_id, ts, pm10, pm25, co)
         select * from unnest($1::int[], $2::text[], $3::int[], $4::timestamptz[], $5::real[], $6::real[], $7::real[])`,
        [chunk.map((r) => r[0]), chunk.map((r) => r[1]), chunk.map((r) => r[2]), chunk.map((r) => new Date(r[3])), chunk.map((r) => r[4]), chunk.map((r) => r[5]), chunk.map((r) => r[6])],
      );
    }

    const events: [number, string, string | null, string, string][] = [
      [at(7, 2), 'sensor', null, '측정 시작', 'IVS-P10-0142'],
      [at(9, 48), 'move', null, '5구역으로 이동', '3구역 → 5구역'],
      [at(11, 2), 'alert', 'caution', '5구역 PM10 88 µg/m³', '권고치 88% · 마스크를 써주세요'],
      [at(11, 24), 'alert', 'danger', '5구역 PM10 112 µg/m³', '권고치 112% · 관리자에게 전달됐어요'],
      [at(11, 31), 'alert', null, '위험 알림 확인', '5구역을 벗어났어요'],
      [at(12, 2), 'move', null, '휴게실로 이동', '5구역 → 휴게실'],
      [at(12, 58), 'sensor', null, '센서 다시 연결', '42초 동안 끊겼어요'],
      [at(14, 5), 'move', null, '3구역으로 이동', '휴게실 → 3구역'],
    ];
    for (const [t, type, level, title, detail] of events.filter((e) => e[0] <= now)) {
      await c.query(`insert into events (worker_id, ts, type, level, title, detail) values ($1, $2, $3, $4, $5, $6)`, [me, new Date(t), type, level, title, detail]);
    }

    // dashboard incidents for the day so far (same story as the worker's log)
    const incidents: [number, string, string, string, string, [string, string][], string[], string | null][] = [
      [at(11, 2), 'caution', 'resolved', '김현수 님 PM10 88 µg/m³', '5구역 · 권고치 88%', [['PM10', '88'], ['권고치 대비', '88%'], ['구역', '5구역']], ['PM10 88 감지', '작업자 앱 마스크 알림', '관리자 확인'], null],
      [at(11, 24), 'danger', 'resolved', '김현수 님 PM10 112 µg/m³', '5구역 · 권고치 112%', [['PM10', '112'], ['권고치 대비', '112%'], ['구역', '5구역']], ['PM10 112 감지', '작업자 앱 대피 알림', '관리자 알림', '작업자 휴게실 도착', '처리 완료'], '작업자를 안전 구역으로 대피시키고 원인을 확인해 주세요.'],
      [at(12, 57), 'sensor', 'auto', '김현수 님 센서 연결이 끊겼어요', '3구역 · 배터리 76%', [['센서', 'IVS-P10-0142'], ['끊긴 시간', '42초'], ['배터리', '76%']], ['60초 넘게 수신 없음', '자동 재연결'], null],
    ];
    for (const [t, type, status, title, sub, metrics, timeline, rec] of incidents.filter((x) => x[0] <= now)) {
      await c.query(
        `insert into alerts (site_id, type, status, title, sub, rec, metrics, worker_ids, timeline, created_at, acked_at, resolved_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)`,
        [site, type, status, title, sub, rec, JSON.stringify(metrics), [me], JSON.stringify(timeline.map((x, k) => [hhmmss(t + k * 60_000), x])), new Date(t)],
      );
    }
    // sites still being prepared (shown greyed out on the dashboard's site picker)
    await c.query(
      `insert into sites (name, facility, status) values ('인천공항 T2', '수하물 처리 시설', 'preparing'), ('인천항 물류센터', '하역장', 'preparing')`,
    );
  });
  const n = await q('select count(*)::int as n from readings');
  console.log(`seed: done${demo ? ` (demo, ${n[0].n} readings)` : ''}`);
  const meRow = await one<{ id: number }>('select id from workers where phone = $1', [mePhone.replace(/\D/g, '')]);
  if (meRow) {
    const inv = await issueInvite(meRow.id, null);
    console.log(`${meName} (${mePhone}) 등록 코드: ${inv.code}  — 72시간 안에 한 번만 쓸 수 있어요`);
  }
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
