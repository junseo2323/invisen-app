-- Login by invite code (issued by a manager / the admin dashboard) instead of SMS OTP.
drop table if exists otp_codes;

create table invites (
  id          serial primary key,
  worker_id   int not null references workers(id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  created_by  int references workers(id) on delete set null, -- null = issued from the server CLI
  created_at  timestamptz not null default now(),
  used_at     timestamptz,
  revoked_at  timestamptz
);
-- at most one live code per worker
create unique index invites_one_active on invites (worker_id) where used_at is null and revoked_at is null;
