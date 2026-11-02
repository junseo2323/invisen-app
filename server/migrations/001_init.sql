-- invisen worker app: initial schema

create table sites (
  id                 serial primary key,
  name               text not null,
  control_room_phone text,
  map_width_m        real,                       -- 현장 지도 실제 크기 (거리 계산용)
  map_height_m       real
);

create table zones (
  id                serial primary key,
  site_id           int not null references sites(id) on delete cascade,
  code              text not null,               -- '3', '5', 'rest-b'
  name              text not null,               -- '3구역'
  pm10_limit        real not null default 100,   -- 권고치 µg/m³
  is_rest           boolean not null default false,
  refuge_name       text,                        -- 가장 가까운 안전 구역
  refuge_distance_m int,
  unique (site_id, code)
);

create table workers (
  id               serial primary key,
  site_id          int not null references sites(id),
  employee_no      text not null unique,
  name             text not null,
  phone            text not null unique,         -- digits only: 01024813307
  company          text,
  team             text,
  role             text not null default 'worker' check (role in ('worker', 'manager')),
  manager_id       int references workers(id),
  shift_name       text,
  shift_start      time,
  shift_end        time,
  assigned_zone_ids int[] not null default '{}',
  -- 위치: 현장 측위 시스템(또는 관리자)이 갱신. 앱은 읽기만 한다.
  current_zone_id  int references zones(id),
  current_spot     text,                         -- 'C-12'
  map_x            real,                         -- 현장 지도 위 % 좌표
  map_y            real,
  position_at      timestamptz,
  alert_level      text not null default 'safe' check (alert_level in ('safe', 'caution', 'danger')),
  active           boolean not null default true,
  created_at       timestamptz not null default now()
);

create table otp_codes (
  phone      text primary key,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   int not null default 0,
  sent_at    timestamptz not null default now()
);

create table sessions (
  token_hash   text primary key,
  worker_id    int not null references workers(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index sessions_worker on sessions (worker_id);

create table sensors (
  id            text primary key,                -- 'IVS-P10-0142'
  worker_id     int unique references workers(id) on delete set null,
  battery       int,
  firmware      text,
  calibrated_on date,
  last_seen_at  timestamptz
);

create table readings (
  id        bigserial primary key,
  worker_id int not null references workers(id) on delete cascade,
  sensor_id text not null references sensors(id),
  zone_id   int references zones(id),
  ts        timestamptz not null,
  pm10      real not null,
  pm25      real,
  co        real,
  temp      real,
  humidity  real,
  unique (sensor_id, ts)
);
create index readings_worker_ts on readings (worker_id, ts desc);

create table events (
  id        bigserial primary key,
  worker_id int not null references workers(id) on delete cascade,
  ts        timestamptz not null default now(),
  type      text not null check (type in ('alert', 'move', 'sensor', 'sos', 'request')),
  level     text check (level in ('caution', 'danger')),
  title     text not null,
  detail    text
);
create index events_worker_ts on events (worker_id, ts desc);

create table sos_calls (
  id           bigserial primary key,
  worker_id    int not null references workers(id) on delete cascade,
  created_at   timestamptz not null default now(),
  status       text not null default 'sent' check (status in ('sent', 'cancelled', 'resolved')),
  zone_id      int references zones(id),
  spot         text,
  pm10         real,
  lat          double precision,
  lng          double precision,
  accuracy     real,
  cancelled_at timestamptz
);

create table push_tokens (
  token      text primary key,
  worker_id  int not null references workers(id) on delete cascade,
  platform   text not null default 'ios',
  updated_at timestamptz not null default now()
);

create table notices (
  id         serial primary key,
  site_id    int not null references sites(id) on delete cascade,
  title      text not null,
  detail     text,
  starts_at  timestamptz,
  ends_at    timestamptz,
  created_at timestamptz not null default now()
);
