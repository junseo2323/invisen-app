// End-to-end API test against a real Postgres (DATABASE_URL_TEST or local invisen_test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgres://invisen:invisen@localhost:5432/invisen_test';
process.env.NODE_ENV = 'test';
process.env.REVIEW_PHONE = '010-9999-0000';
process.env.REVIEW_CODE = '246810';

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { buildApp } = await import('../src/app.js');
const { issueInvite } = await import('../src/invites.js');
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let token = '';
let managerToken = '';

const call = async (method: string, url: string, body?: unknown, auth = true) => {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as object,
    headers: auth && token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

before(async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(() => {});
  await pool.query(`
    insert into sites (id, name, control_room_phone, map_width_m, map_height_m) values (1, '테스트 현장', '0200000000', 100, 100);
    insert into zones (id, site_id, code, name, pm10_limit, refuge_name, refuge_distance_m) values (1, 1, '3', '3구역', 100, '휴게실 B', 40);
    insert into workers (id, site_id, employee_no, name, phone, role) values (1, 1, 'M-1', '반장', '01000000001', 'manager');
    insert into workers (id, site_id, employee_no, name, phone, manager_id, current_zone_id, current_spot, shift_start, shift_end, map_x, map_y)
      values (2, 1, 'W-1', '김현수', '01024813307', 1, 1, 'C-12', '00:00', '23:59', 10, 10);
    insert into workers (id, site_id, employee_no, name, phone, current_zone_id, map_x, map_y) values (3, 1, 'W-2', '이도윤', '01000000002', 1, 13, 14);
    insert into sensors (id, battery) values ('IVS-P10-0142', 90), ('IVS-P10-0157', 50);
    update sensors set worker_id = 3 where id = 'IVS-P10-0157';
    select setval('workers_id_seq', 10);
  `);
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  await pool.end();
});

test('invite code login', async () => {
  const { code } = await issueInvite(2, null);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await call('POST', '/api/auth/login', { phone: '010-2481-3307', code: wrong }, false)).body.error, 'invalid_code');
  const ok = await call('POST', '/api/auth/login', { phone: '010-2481-3307', code }, false);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.me.name, '김현수');
  token = ok.body.token;
  // single use
  assert.equal((await call('POST', '/api/auth/login', { phone: '01024813307', code }, false)).body.error, 'expired');
});

test('a code locks after 5 wrong tries and a new code replaces the old one', async () => {
  const first = await issueInvite(3, null);
  const { code } = await issueInvite(3, null); // revokes `first`
  if (first.code !== code) {
    assert.equal((await call('POST', '/api/auth/login', { phone: '01000000002', code: first.code }, false)).status, 400);
  }
  const bad = code === '999999' ? '999998' : '999999';
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await call('POST', '/api/auth/login', { phone: '01000000002', code: bad }, false)).status;
  assert.equal(last, 429);
  assert.equal((await call('POST', '/api/auth/login', { phone: '01000000002', code }, false)).body.error, 'locked');
});

test('unregistered numbers get the same answer as a wrong code', async () => {
  const r = await call('POST', '/api/auth/login', { phone: '01099999999', code: '123456' }, false);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_code');
});

test('managers issue invite codes for their own site only', async () => {
  const workerTry = await call('POST', '/api/admin/invites', { workerId: 3 });
  assert.equal(workerTry.status, 403);
  const m = await issueInvite(1, null);
  managerToken = (await call('POST', '/api/auth/login', { phone: '01000000001', code: m.code }, false)).body.token;
  const saved = token;
  token = managerToken;
  const inv = await call('POST', '/api/admin/invites', { phone: '010-0000-0002', ttlHours: 24 });
  assert.equal(inv.status, 200);
  assert.match(inv.body.code, /^\d{6}$/);
  assert.equal(inv.body.worker.name, '이도윤');
  assert.equal((await call('POST', '/api/admin/invites', { workerId: 999 })).status, 404);
  token = saved;
  assert.equal((await call('POST', '/api/auth/login', { phone: '01000000002', code: inv.body.code }, false)).status, 200);
});

test('review login creates a demo account that stays out of team views', async () => {
  const r = await call('POST', '/api/auth/login', { phone: '01099990000', code: '246810' }, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.me.demo, true);
  assert.equal(r.body.me.name, '심사용 계정');
  const again = await call('POST', '/api/auth/login', { phone: '01099990000', code: '246810' }, false);
  assert.equal(again.body.me.id, r.body.me.id, 'same account every time');
  assert.equal((await call('POST', '/api/auth/login', { phone: '01099990000', code: '111111' }, false)).status, 400);
});

test('auth is required', async () => {
  assert.equal((await call('GET', '/api/me', undefined, false)).status, 401);
});

test('sensor pairing', async () => {
  assert.equal((await call('PUT', '/api/me/sensor', { sensorId: 'IVS-P10-0157' })).body.error, 'sensor_in_use');
  assert.equal((await call('PUT', '/api/me/sensor', { sensorId: 'IVS-P10-9999' })).status, 404);
  assert.equal((await call('PUT', '/api/me/sensor', { sensorId: 'IVS-P10-0142' })).status, 200);
  assert.equal((await call('GET', '/api/me')).body.sensor.id, 'IVS-P10-0142');
});

test('readings raise caution then danger alerts once', async () => {
  const now = Date.now();
  const r = (offsetMin: number, pm10: number) => ({ ts: new Date(now - offsetMin * 60_000).toISOString(), pm10 });
  const res = await call('POST', '/api/readings', {
    sensorId: 'IVS-P10-0142',
    battery: 77,
    readings: [r(10, 40), r(9, 85), r(8, 86), r(7, 120), r(6, 125), r(5, 50)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 6);
  assert.equal(res.body.level, 'safe');
  // duplicates are ignored
  assert.equal((await call('POST', '/api/readings', { sensorId: 'IVS-P10-0142', readings: [r(10, 40)] })).body.accepted, 0);
  // escalating again within 10 minutes does not repeat the event
  await call('POST', '/api/readings', { sensorId: 'IVS-P10-0142', readings: [r(1, 130)] });
  const log = (await call('GET', '/api/me/events')).body;
  const alerts = log.today.filter((e: { type: string; level: string | null }) => e.type === 'alert' && e.level);
  assert.deepEqual(alerts.map((e: { level: string }) => e.level).sort(), ['caution', 'danger']);
  assert.match(alerts.find((e: { level: string }) => e.level === 'danger').detail, /권고치 120%/);
});

test('readings from an unpaired sensor are rejected', async () => {
  const res = await call('POST', '/api/readings', { sensorId: 'IVS-P10-0157', readings: [{ ts: new Date().toISOString(), pm10: 1 }] });
  assert.equal(res.body.error, 'sensor_not_paired');
});

test('status, exposure, site', async () => {
  const st = (await call('GET', '/api/me/status')).body;
  assert.equal(st.zone.name, '3구역');
  assert.equal(st.now.level, 'danger');
  assert.equal(st.refuge.name, '휴게실 B');
  assert.ok(st.exposure.percent >= 0);
  const ex = (await call('GET', '/api/me/exposure')).body;
  assert.equal(ex.week.length, 7);
  assert.equal(ex.alerts.danger, 1);
  assert.equal(ex.peak.value, 130);
  const site = (await call('GET', '/api/site')).body;
  assert.equal(site.team.length, 1, 'demo account is not in the team');
  assert.equal(site.team[0].distanceM, 5); // (3%, 4%) of a 100 m map
});

test('sos and cancel', async () => {
  const sos = await call('POST', '/api/sos', { lat: 37.46, lng: 126.44, accuracy: 12 });
  assert.equal(sos.status, 200);
  assert.equal(sos.body.zone, '3구역');
  assert.equal(sos.body.spot, 'C-12');
  assert.equal((await call('POST', `/api/sos/${sos.body.id}/cancel`)).status, 204);
  assert.equal((await call('POST', `/api/sos/${sos.body.id}/cancel`)).status, 404);
});

test('push token and logout', async () => {
  assert.equal((await call('PUT', '/api/me/push-token', { token: 'a'.repeat(64) })).status, 204);
  assert.equal((await call('PUT', '/api/me/push-token', { token: 'nothex' })).status, 400);
  assert.equal((await call('POST', '/api/auth/logout')).status, 204);
  assert.equal((await call('GET', '/api/me')).status, 401);
});
