-- Initial schema for a new, dedicated Supabase project.
begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated, service_role;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;
create policy "Read own profile" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "Insert own profile" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "Update own profile" on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

create function public.set_updated_at() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger profile_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (new.id, new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', 'Lab member'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'))
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
create trigger dashboard_new_user after insert on auth.users
  for each row execute function public.handle_new_user();

-- Exact email addresses, managed only by the database owner/server.
-- Empty by default: enabling Google OAuth does not approve all Google users.
create table public.access_allowlist (
  email text primary key check (email = lower(btrim(email))),
  note text,
  created_at timestamptz not null default now()
);
alter table public.access_allowlist enable row level security;
revoke all on public.access_allowlist from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.access_allowlist to service_role;

create function public.email_is_allowed() returns boolean language sql stable
security definer set search_path = public as $$
  select exists (select 1 from public.access_allowlist
    where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;
revoke all on function public.email_is_allowed() from public, anon, authenticated, service_role;
grant execute on function public.email_is_allowed() to authenticated;

create table public.usage_reports (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  display_name text not null default 'Lab member',
  slurm_user text not null check (char_length(btrim(slurm_user)) between 1 and 64),
  cluster text not null check (cluster ~ '^[A-Za-z0-9_-]{1,48}$'),
  resource_pool text not null check (char_length(btrim(resource_pool)) between 1 and 64),
  start_time timestamptz not null,
  duration_hours numeric not null check (duration_hours >= 0.25 and duration_hours <= 8760),
  node_count integer not null default 1 check (node_count between 1 and 256),
  gpu_count integer not null check (gpu_count between 1 and 256),
  gpu_hours numeric generated always as (gpu_count * duration_hours) stored,
  reason text not null default '' check (char_length(reason) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.usage_reports enable row level security;
revoke all on public.usage_reports from public, anon, authenticated, service_role;
grant select on public.usage_reports to anon;
grant select, insert, update, delete on public.usage_reports to authenticated, service_role;
create policy "Read reservations" on public.usage_reports for select to anon, authenticated using (true);
create policy "Create own reservation" on public.usage_reports for insert to authenticated
  with check (auth.uid() = member_id and public.email_is_allowed());
create policy "Edit own reservation" on public.usage_reports for update to authenticated
  using (auth.uid() = member_id and public.email_is_allowed())
  with check (auth.uid() = member_id and public.email_is_allowed());
create policy "Delete own reservation" on public.usage_reports for delete to authenticated
  using (auth.uid() = member_id);
create index usage_reports_window on public.usage_reports (cluster, resource_pool, start_time);
create trigger report_updated before update on public.usage_reports
  for each row execute function public.set_updated_at();

create function public.report_display_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select coalesce(nullif(full_name, ''), 'Lab member') into new.display_name
    from public.profiles where id = new.member_id;
  return new;
end;
$$;
revoke all on function public.report_display_name() from public, anon, authenticated, service_role;
create trigger report_name before insert or update on public.usage_reports
  for each row execute function public.report_display_name();

create table public.cluster_live (
  cluster text primary key,
  collected_at timestamptz not null,
  agent_host text,
  agent_job_id text,
  total_gpus integer,
  gpus_used integer,
  gpus_pending integer,
  running_jobs integer,
  pending_jobs integer,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.cluster_live enable row level security;
revoke all on public.cluster_live from public, anon, authenticated, service_role;
grant select on public.cluster_live to anon, authenticated;
grant select, insert, update, delete on public.cluster_live to service_role;
create policy "Read telemetry" on public.cluster_live for select to anon, authenticated using (true);
create trigger telemetry_updated before update on public.cluster_live
  for each row execute function public.set_updated_at();

create table public.cluster_live_history (
  id bigint generated always as identity primary key,
  cluster text not null,
  collected_at timestamptz not null,
  total_gpus integer,
  gpus_used integer,
  gpus_pending integer,
  running_jobs integer,
  pending_jobs integer,
  unique (cluster, collected_at)
);
alter table public.cluster_live_history enable row level security;
revoke all on public.cluster_live_history from public, anon, authenticated, service_role;
revoke all on sequence public.cluster_live_history_id_seq from public, anon, authenticated, service_role;
grant select on public.cluster_live_history to anon, authenticated;
grant select, insert, update, delete on public.cluster_live_history to service_role;
grant usage, select on sequence public.cluster_live_history_id_seq to service_role;
create policy "Read history" on public.cluster_live_history for select to anon, authenticated using (true);
create index cluster_live_history_time on public.cluster_live_history (cluster, collected_at desc);

commit;
