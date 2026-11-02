// Admin dashboard API against a real Postgres (DATABASE_URL_TEST or local invisen_test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgres://invisen:invisen@localhost:5432/invisen_test';
process.env.NODE_ENV = 'test';

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { buildApp } = await import('../src/app.js');
const { checkSensors, checkAdvice } = await import('../src/watchdog.js');
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let admin = '';
let worker = '';

const call = async (method: string, url: string, body?: unknown, token = admin) => {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let parsed: unknown = null;
  try {
    parsed = res.body ? JSON.parse(res.body) : null;
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed as Record<string, any>, raw: res.body, headers: res.headers };
};

before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(() => {});
  await pool.query(`
    insert into sites (id, name, shifts) values (1, '테스트 현장', '[{"name":"주간 A조","start":"00:00","end":"23:59"}]');
    insert into zones (id, site_id, code, name, pm10_limit) values (1, 1, '3', '3구역', 100), (2, 1, 'rest', '휴게실', 100);
    update zones set is_rest = true where id = 2;
    insert into workers (id, site_id, employee_no, name, phone, current_zone_id, shift_name, shift_start, shift_end)
      values (2, 1, 'W-1', '김현수', '01024813307', 1, '주간 A조', '00:00', '23:59');
    insert into sensors (id, site_id, worker_id) values ('IVS-P10-0142', 1, 2);
    insert into sensors (id, site_id) values ('IVS-P10-0170', 1);
    select setval('workers_id_seq', 10);
  `);
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  await pool.end();
});

test('admin login with the default admin/admin account', async () => {
  assert.equal((await call('POST', '/api/admin/auth/login', { username: 'admin', password: 'nope' }, '')).status, 400);
  const r = await call('POST', '/api/admin/auth/login', { username: 'ADMIN', password: 'admin', remember: false }, '');
  assert.equal(r.status, 200);
  assert.equal(r.body.admin.mustChangePassword, true);
  admin = r.body.token;
  assert.equal((await call('GET', '/api/admin/me')).body.username, 'admin');
  assert.equal((await call('GET', '/api/admin/me', undefined, 'bad-token')).status, 401);
  // a worker token is not an admin token
  assert.equal((await call('GET', '/api/admin/sites', undefined, '')).status, 401);
});

test('add a worker, who then logs into the app with the issued code', async () => {
  const opts = await call('GET', '/api/admin/sites/1/form-options');
  assert.deepEqual(opts.body.zones.map((z: { name: string }) => z.name), ['3구역']);
  const r = await call('POST', '/api/admin/sites/1/workers', { name: '이하준', employeeNo: 'W-3', phone: '010-1111-2222', org: '협력사 A · 수하물 처리팀', zoneIds: [1], shift: '주간 A조' });
  assert.equal(r.status, 200);
  assert.match(r.body.invite.code, /^\d{6}$/);
  assert.equal((await call('POST', '/api/admin/sites/1/workers', { name: 'x', employeeNo: 'W-3', phone: '010-1111-3333' })).status, 409);
  const list = await call('GET', '/api/admin/sites/1/workers');
  const added = list.body.find((w: { name: string }) => w.name === '이하준');
  assert.equal(added.conn, 'pending');
  assert.equal(added.org, '협력사 A · 수하물 처리팀');
  // regenerate → the first code no longer works
  const again = await call('POST', `/api/admin/workers/${added.id}/invite`);
  const old = await call('POST', '/api/auth/login', { phone: '01011112222', code: r.body.invite.code }, '');
  if (again.body.code !== r.body.invite.code) assert.equal(old.status, 400);
  const login = await call('POST', '/api/auth/login', { phone: '01011112222', code: again.body.code }, '');
  assert.equal(login.status, 200);
  assert.equal((await call('GET', '/api/admin/sites/1/workers')).body.find((w: { id: number }) => w.id === added.id).conn, 'off');
});

test('readings create dashboard incidents; admins acknowledge and resolve them', async () => {
  const { code } = (await call('POST', '/api/admin/workers/2/invite')).body;
  worker = (await call('POST', '/api/auth/login', { phone: '01024813307', code }, '')).body.token;
  const now = Date.now();
  const r = (m: number, pm10: number) => ({ ts: new Date(now - m * 60_000).toISOString(), pm10 });
  const up = await call('POST', '/api/readings', { sensorId: 'IVS-P10-0142', battery: 80, readings: [r(6, 40), r(5, 85), r(4, 120), r(0, 130)] }, worker);
  assert.equal(up.status, 200);
  const alerts = (await call('GET', '/api/admin/sites/1/alerts')).body.today;
  const danger = alerts.find((a: { type: string }) => a.type === 'danger');
  const caution = alerts.find((a: { type: string }) => a.type === 'caution');
  assert.ok(danger && caution);
  assert.equal(danger.people[0].name, '김현수');
  assert.equal(danger.primary.href, '#worker-2');
  assert.equal((await call('GET', '/api/admin/sites/1/alerts/pending-count')).body.n, 2);
  assert.equal((await call('POST', `/api/admin/alerts/${caution.id}/ack`)).body.acked, true);
  assert.equal((await call('POST', `/api/admin/alerts/${danger.id}/resolve`)).status, 200);
  const after = (await call('GET', '/api/admin/sites/1/alerts')).body.today;
  assert.equal(after.find((a: { id: number }) => a.id === danger.id).statusLabel, '처리 완료');
  assert.ok(after.find((a: { id: number }) => a.id === danger.id).timeline.some((t: string[]) => t[1].includes('처리 완료')));
});

test('overview, worker detail and shift order', async () => {
  const o = (await call('GET', '/api/admin/sites/1/overview')).body;
  assert.equal(o.kpis.working, 1);
  assert.equal(o.kpis.danger, 1);
  assert.equal(o.workers[0].name, '김현수');
  assert.equal(o.zones[0].name, '3구역');
  const d = (await call('GET', '/api/admin/workers/2')).body;
  assert.equal(d.state, 'danger');
  assert.equal(d.week.length, 7);
  assert.ok(d.bars.length >= 1);
  assert.equal((await call('POST', '/api/admin/workers/2/shift-order')).body.sent, true);
  const log = (await call('GET', '/api/me/events', undefined, worker)).body;
  assert.ok(log.today.some((e: { title: string }) => e.title === '교대 지시'));
  const csv = await call('GET', '/api/admin/workers/2/readings.csv');
  assert.match(csv.headers['content-type'] as string, /text\/csv/);
  assert.ok(csv.raw.split('\n').length >= 5);
});

test('SOS shows up as an incident and cancelling resolves it', async () => {
  const sos = await call('POST', '/api/sos', { lat: 37.46, lng: 126.44 }, worker);
  let a = (await call('GET', '/api/admin/sites/1/alerts')).body.today.find((x: { type: string }) => x.type === 'sos');
  assert.equal(a.statusLabel, '대기');
  await call('POST', `/api/sos/${sos.body.id}/cancel`, undefined, worker);
  a = (await call('GET', '/api/admin/sites/1/alerts')).body.today.find((x: { type: string }) => x.type === 'sos');
  assert.equal(a.statusLabel, '처리 완료');
});

test('watchdog: sensor disconnect incident auto-resolves; advice at 80% cumulative', async () => {
  await pool.query(`update sensors set last_seen_at = now() - interval '5 minutes' where id = 'IVS-P10-0142'`);
  await checkSensors();
  await checkSensors(); // no duplicate
  let s = (await call('GET', '/api/admin/sites/1/alerts')).body.today.filter((x: { type: string }) => x.type === 'sensor');
  assert.equal(s.length, 1);
  await call('POST', '/api/readings', { sensorId: 'IVS-P10-0142', readings: [{ ts: new Date().toISOString(), pm10: 30 }] }, worker);
  await checkSensors();
  s = (await call('GET', '/api/admin/sites/1/alerts')).body.today.filter((x: { type: string }) => x.type === 'sensor');
  assert.equal(s[0].statusLabel, '자동 해결');
  // 8 h at the limit → 100% cumulative
  const rows = Array.from({ length: 96 }, (_, i) => ({ ts: new Date(Date.now() - (i + 1) * 5 * 60_000 + 1000).toISOString(), pm10: 100 }));
  await call('POST', '/api/readings', { sensorId: 'IVS-P10-0142', readings: rows }, worker);
  await checkAdvice();
  await checkAdvice();
  const adv = (await call('GET', '/api/admin/sites/1/alerts')).body.today.filter((x: { type: string }) => x.type === 'advice');
  assert.equal(adv.length, 1);
  assert.equal(adv[0].primary.label, '교대 지시');
});

test('sensors, reports, settings', async () => {
  const s = (await call('GET', '/api/admin/sites/1/sensors')).body;
  assert.equal(s.counts.total, 2);
  assert.equal(s.counts.free, 1);
  assert.equal((await call('POST', '/api/admin/sites/1/sensors', { id: 'ivs-p10-0200', maker: '파트너 A', model: 'W-3' })).status, 200);
  assert.equal((await call('POST', '/api/admin/sites/1/sensors', { id: 'IVS-P10-0200' })).status, 409);
  const rep = (await call('GET', '/api/admin/sites/1/reports?period=week')).body;
  assert.equal(rep.columns.length, 7);
  assert.equal(rep.heat[0].zone, '3구역');
  assert.ok(rep.people.length >= 1);
  const set = (await call('GET', '/api/admin/sites/1/settings')).body;
  assert.equal(set.limits.pm10, 100);
  assert.equal(set.rules.dEvac, true);
  await call('PUT', '/api/admin/sites/1/settings', { limits: { pm10: 150, pm25: 35, co: 25 }, rules: { sensor: false, dEvac: false } });
  const set2 = (await call('GET', '/api/admin/sites/1/settings')).body;
  assert.equal(set2.limits.pm10, 150);
  assert.equal(set2.rules.sensor, false);
  assert.equal(set2.rules.dEvac, true, 'evacuation alerts cannot be turned off');
});

test("yesterday's alerts, archived weekly report, sensor zones, integrations, app caution rule", async () => {
  await pool.query(`insert into alerts (site_id, type, status, title, created_at) values (1, 'caution', 'resolved', '어제 알림', now() - interval '1 day')`);
  const y = (await call('GET', '/api/admin/sites/1/alerts?day=yesterday')).body;
  assert.equal(y.day, 'yesterday');
  assert.ok(y.list.some((a: { title: string }) => a.title === '어제 알림'));
  const t = (await call('GET', '/api/admin/sites/1/alerts')).body;
  assert.ok(!t.list.some((a: { title: string }) => a.title === '어제 알림'));
  assert.ok(t.yesterday.n >= 1);
  assert.equal(typeof t.pending, 'number');
  // a past week: no "today" column, today's readings are not in it
  const end = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const rep = (await call('GET', `/api/admin/sites/1/reports?period=week&end=${end}`)).body;
  assert.equal(rep.end, end);
  assert.equal(rep.columns.length, 7);
  assert.ok(!rep.columns.some((c: { today: boolean }) => c.today));
  assert.equal(rep.people.length, 0);
  assert.equal((await call('GET', '/api/admin/sites/1/reports?period=week&end=nope')).status, 400);
  // sensors carry the wearer's zone
  const s = (await call('GET', '/api/admin/sites/1/sensors')).body;
  assert.equal(s.sensors.find((x: { id: string }) => x.id === 'IVS-P10-0142').zone, '3구역');
  assert.equal(s.sensors.find((x: { id: string }) => x.id === 'IVS-P10-0170').zone, null);
  const set = (await call('GET', '/api/admin/sites/1/settings')).body;
  assert.equal(typeof set.integrations.push, 'boolean');
  assert.equal(typeof set.integrations.webhook, 'boolean');
  assert.ok(set.integrations.app.n >= 1);
  // the worker app follows "주의: 작업자 앱 알림"
  assert.equal((await call('GET', '/api/me', undefined, worker)).body.cautionAlerts, true);
  await call('PUT', '/api/admin/sites/1/settings', { rules: { cApp: false } });
  assert.equal((await call('GET', '/api/me', undefined, worker)).body.cautionAlerts, false);
  await call('PUT', '/api/admin/sites/1/settings', { rules: { cApp: true } });
});

test('accounts: create a viewer, viewers cannot change things, password change', async () => {
  assert.equal((await call('POST', '/api/admin/admins', { username: 'viewer1', name: '최동훈', role: 'viewer', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/admin/admins', { username: 'viewer1', name: '최동훈', role: 'viewer', password: 'viewer-pass-1' })).status, 200);
  const v = (await call('POST', '/api/admin/auth/login', { username: 'viewer1', password: 'viewer-pass-1' }, '')).body.token;
  assert.equal((await call('GET', '/api/admin/sites/1/overview', undefined, v)).status, 200);
  assert.equal((await call('POST', '/api/admin/workers/2/shift-order', undefined, v)).status, 403);
  // the owner hands out a temporary password: sessions end, the next sign-in must change it
  const vid = (await call('GET', '/api/admin/sites/1/settings')).body.members.find((m: { username: string }) => m.username === 'viewer1').id;
  assert.equal((await call('PATCH', `/api/admin/admins/${vid}`, { password: 'temp-pass-9' })).status, 200);
  assert.equal((await call('GET', '/api/admin/me', undefined, v)).status, 401);
  const relog = (await call('POST', '/api/admin/auth/login', { username: 'viewer1', password: 'temp-pass-9' }, '')).body;
  assert.equal(relog.admin.mustChangePassword, true);
  assert.equal((await call('PATCH', `/api/admin/admins/${vid}`, { active: false }, relog.token)).status, 403);
  assert.equal((await call('POST', '/api/admin/me/password', { current: 'wrong', next: 'new-password-1' })).status, 400);
  assert.equal((await call('POST', '/api/admin/me/password', { current: 'admin', next: 'new-password-1' })).status, 204);
  assert.equal((await call('GET', '/api/admin/me')).body.mustChangePassword, false);
  assert.equal((await call('POST', '/api/admin/auth/login', { username: 'admin', password: 'admin' }, '')).status, 400);
  assert.equal((await call('POST', '/api/admin/auth/logout')).status, 204);
  assert.equal((await call('GET', '/api/admin/me')).status, 401);
});
