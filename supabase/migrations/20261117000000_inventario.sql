create table if not exists public.lego_state (
  id integer primary key check (id = 1),
  version bigint not null default 0,
  payload jsonb not null
);

insert into public.lego_state (id, payload)
values (1, '{"catalog":[],"copies":[],"boxes":[]}'::jsonb)
on conflict (id) do nothing;

create table if not exists public.lego_requests (
  id uuid primary key,
  completed_at timestamptz not null default now()
);

create table if not exists public.lego_photos (
  id uuid primary key,
  set_id uuid not null,
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  content bytea not null
);

create index if not exists lego_photos_set_id on public.lego_photos (set_id);
alter table public.lego_state enable row level security;
alter table public.lego_requests enable row level security;
alter table public.lego_photos enable row level security;
revoke all on table public.lego_state, public.lego_requests, public.lego_photos from public, anon, authenticated;
grant select, insert, update, delete on table public.lego_state, public.lego_requests, public.lego_photos to service_role;

create or replace function public.lego_read(p_request uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'version', version, 'payload', payload,
    'duplicate', exists (select 1 from public.lego_requests where id = p_request)
  )
  from public.lego_state where id = 1;
$$;

create or replace function public.lego_commit(
  p_expected bigint, p_request uuid, p_payload jsonb, p_changed boolean,
  p_photos jsonb, p_delete_set uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_state public.lego_state%rowtype;
begin
  select * into strict current_state from public.lego_state where id = 1 for update;
  if exists (select 1 from public.lego_requests where id = p_request) then
    return jsonb_build_object('status', 'duplicate', 'version', current_state.version, 'payload', current_state.payload);
  end if;
  if current_state.version <> p_expected then
    return jsonb_build_object('status', 'conflict', 'version', current_state.version, 'payload', current_state.payload);
  end if;
  if p_changed then
    if p_delete_set is not null then
      delete from public.lego_photos where set_id = p_delete_set;
    end if;
    insert into public.lego_photos (id, set_id, mime, content)
      select photo.id, photo.set_id, photo.mime, decode(photo.data, 'base64')
      from jsonb_to_recordset(p_photos) as photo(id uuid, set_id uuid, mime text, data text);
    update public.lego_state set version = version + 1, payload = p_payload
      where id = 1 returning * into strict current_state;
  end if;
  insert into public.lego_requests (id) values (p_request);
  delete from public.lego_requests where completed_at < now() - interval '7 days';
  return jsonb_build_object('status', 'saved', 'version', current_state.version, 'payload', current_state.payload);
end;
$$;

create or replace function public.lego_restore(p_payload jsonb, p_photos jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_version bigint;
begin
  select version into strict current_version from public.lego_state where id = 1 for update;
  if current_version <> 0
      or exists (select 1 from public.lego_requests)
      or exists (select 1 from public.lego_photos) then
    return false;
  end if;
  if jsonb_typeof(p_payload -> 'catalog') is distinct from 'array'
      or jsonb_typeof(p_payload -> 'copies') is distinct from 'array'
      or jsonb_typeof(p_payload -> 'boxes') is distinct from 'array' then
    raise exception 'Inventario no válido';
  end if;
  insert into public.lego_photos (id, set_id, mime, content)
    select photo.id, photo.set_id, photo.mime, decode(photo.data, 'base64')
    from jsonb_to_recordset(p_photos) as photo(id uuid, set_id uuid, mime text, data text);
  update public.lego_state set version = 1, payload = p_payload where id = 1;
  return true;
end;
$$;

create or replace function public.lego_ping()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.lego_state where id = 1);
$$;

revoke all on function public.lego_commit(bigint, uuid, jsonb, boolean, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.lego_read(uuid) from public, anon, authenticated;
revoke all on function public.lego_restore(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.lego_ping() from public, anon, authenticated;
grant execute on function public.lego_commit(bigint, uuid, jsonb, boolean, jsonb, uuid) to service_role;
grant execute on function public.lego_read(uuid) to service_role;
grant execute on function public.lego_restore(jsonb, jsonb) to service_role;
grant execute on function public.lego_ping() to anon, authenticated, service_role;
