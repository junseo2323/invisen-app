-- Demo / review accounts (App Store beta review): use the simulated sensor and stay out of team views.
alter table workers add column is_demo boolean not null default false;
