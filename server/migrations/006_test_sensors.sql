-- 테스트용 센서 (2026-11-03)
-- 실물 센서 전, 앱 로그인 화면에 블루투스 없이 늘 뜨고 누구나 고를 수 있는 가상 센서.
-- 여러 작업자가 같은 테스트 센서를 동시에 쓸 수 있어야 하므로 연결은 sensors.worker_id(1:1) 가 아니라
-- workers.test_sensor_id 에 둔다. 앱은 테스트 센서에 가상 측정값(시뮬레이터)을 보낸다.
alter table sensors add column is_test boolean not null default false;
alter table workers add column test_sensor_id text references sensors(id) on delete set null;

-- 센서 초기화: 지금까지 등록한 센서와 그 센서의 측정값을 지운다. 심사용 계정 센서(IVS-DEMO-*)는 둔다.
update alerts set status = 'auto', resolved_at = now()
 where type = 'sensor' and status in ('open', 'acked');
delete from readings where sensor_id in (select id from sensors where id not like 'IVS-DEMO-%');
delete from sensors where id not like 'IVS-DEMO-%';
update workers set alert_level = 'safe' where not is_demo;

-- 테스트 센서 5대 (첫 현장 소속, 관리자 대시보드 › 센서 에 보임)
insert into sensors (id, site_id, maker, model, items, battery, firmware, calibrated_on, is_test)
select 'IVS-TEST-' || lpad(n::text, 4, '0'), (select min(id) from sites), 'invisen', '테스트 센서',
       'PM10 · PM2.5 · CO · 온습도', 100 - (n - 1) * 8, 'test', current_date, true
  from generate_series(1, 5) as n;
