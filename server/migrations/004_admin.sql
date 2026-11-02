-- Admin dashboard (web): admin accounts, incidents/alerts, site settings, sensor metadata.
create extension if not exists pgcrypto;

create table admins (
  id                   serial primary key,
  username             text not null unique,
  password_hash        text not null,                 -- bcrypt (pgcrypto crypt/gen_salt('bf'))
  name                 text not null,
  title                text,
  role                 text not null default 'admin' check (role in ('owner', 'admin', 'viewer')),
  must_change_password boolean not null default false,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  last_login_at        timestamptz
);

create table admin_sessions (
  token_hash  text primary key,
  admin_id    int not null references admins(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index admin_sessions_admin on admin_sessions (admin_id);

-- first account: admin / admin (the dashboard asks to change it)
insert into admins (username, password_hash, name, title, role, must_change_password)
select 'admin', crypt('admin', gen_salt('bf', 10)), '관리자', '현장 관리자', 'owner', true
where not exists (select 1 from admins);

-- site settings
alter table sites
  add column facility   text,
  add column address    text,
  add column status     text not null default 'active' check (status in ('active', 'preparing')),
  add column pm25_limit real not null default 50,
  add column co_limit   real not null default 30,
  add column shifts     jsonb not null default '[]'::jsonb,   -- [{ "name": "주간 A조", "start": "07:00", "end": "15:00" }]
  add column rules      jsonb not null default '{}'::jsonb;   -- alert rule toggles

update sites s set shifts = coalesce((
  select jsonb_agg(distinct jsonb_build_object('name', w.shift_name, 'start', to_char(w.shift_start, 'HH24:MI'), 'end', to_char(w.shift_end, 'HH24:MI')))
    from workers w where w.site_id = s.id and w.shift_name is not null and w.shift_start is not null
), '[]'::jsonb);

-- sensors belong to a site (spares too) and carry their hardware info
alter table sensors
  add column site_id int references sites(id),
  add column maker   text,
  add column model   text,
  add column items   text;
update sensors s set site_id = w.site_id from workers w where w.id = s.worker_id and s.site_id is null;
update sensors set site_id = (select min(id) from sites) where site_id is null;

-- incidents shown on the dashboard (caution / danger / SOS / sensor / advice / notice)
create table alerts (
  id          bigserial primary key,
  site_id     int not null references sites(id) on delete cascade,
  type        text not null check (type in ('caution', 'danger', 'sos', 'sensor', 'advice', 'notice')),
  status      text not null default 'open' check (status in ('open', 'acked', 'resolved', 'auto', 'info')),
  title       text not null,
  sub         text,
  rec         text,
  metrics     jsonb not null default '[]'::jsonb,     -- [["PM10", "112"], …]
  worker_ids  int[] not null default '{}',
  timeline    jsonb not null default '[]'::jsonb,     -- [["14:31:02", "누적 80% 초과 감지"], …]
  dedup_key   text,
  created_at  timestamptz not null default now(),
  acked_at    timestamptz,
  acked_by    int references admins(id) on delete set null,
  resolved_at timestamptz,
  resolved_by int references admins(id) on delete set null
);
create index alerts_site_time on alerts (site_id, created_at desc);
create unique index alerts_live_dedup on alerts (dedup_key) where dedup_key is not null and status in ('open', 'acked');
