-- Defense in depth: restrict access to an explicit allow-list of Plaza emails.
-- Even if an account were somehow created, it gets nothing unless listed here.

create table if not exists allowed_users (
  email       text primary key,
  note        text,
  created_at  timestamptz default now()
);
alter table allowed_users enable row level security;
revoke all on allowed_users from anon, authenticated;

insert into allowed_users (email, note) values
  ('william@plazaandassociates.com', 'Principal — owner')
on conflict (email) do nothing;

create or replace function is_allowed_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from allowed_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- tighten the table policies to require allow-list membership
drop policy if exists deals_auth_all on deals;
create policy deals_auth_all on deals
  for all to authenticated
  using (is_allowed_user()) with check (is_allowed_user());

drop policy if exists acts_auth_all on activities;
create policy acts_auth_all on activities
  for all to authenticated
  using (is_allowed_user()) with check (is_allowed_user());
