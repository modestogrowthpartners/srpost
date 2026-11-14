-- Sr. Post: portal de aprovacao.
-- Todo acesso passa pela Edge Function "api" (service_role). Nenhuma tabela e exposta a anon/authenticated.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------- Tabelas ----------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  segment text,
  timezone text not null default 'America/Sao_Paulo',
  is_demo boolean not null default false,
  status text not null default 'active' check (status in ('active','paused')),
  created_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients(id) on delete cascade,
  name text not null default 'Agente Sr. Post',
  role_line text,
  bio text,
  tone text,
  pillars text[] not null default '{}',
  posts_per_week int not null default 7 check (posts_per_week between 1 and 28),
  post_times text[] not null default '{12:00,18:30}',
  platforms text[] not null default '{instagram}',
  status text not null default 'ativo' check (status in ('ativo','pausado','configurando')),
  updated_at timestamptz not null default now()
);

create table public.portal_links (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  token_hash text not null unique,
  label text,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Chaves de acesso: role 'admin' (painel do time) ou 'ingest' (n8n / agente gerador).
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('admin','ingest')),
  key_hash text not null unique,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  value text not null
);

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  platform text not null default 'instagram' check (platform in ('instagram')),
  external_id text not null,
  username text,
  name text,
  profile_picture_url text,
  account_type text,
  followers_count int,
  scopes text[] not null default '{}',
  token_secret_id uuid,
  token_issued_at timestamptz,
  token_expires_at timestamptz,
  status text not null default 'connected' check (status in ('connected','expired','revoked')),
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, platform)
);
create index social_accounts_external_idx on public.social_accounts (platform, external_id);

create table public.oauth_states (
  state text primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);

create table public.creatives (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  kind text not null check (kind in ('video','image')),
  format text not null default 'reel' check (format in ('reel','feed','story')),
  media_url text not null,
  media_path text,
  thumb_url text,
  title text,
  caption text not null default '',
  hashtags text not null default '',
  ai_generated boolean not null default false,
  suggested_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','adjust','replaced')),
  decision_comment text,
  decided_at timestamptz,
  revision_of uuid references public.creatives(id) on delete set null,
  source text not null default 'upload' check (source in ('upload','api')),
  external_ref text,
  created_at timestamptz not null default now(),
  check ((format = 'reel' and kind = 'video') or format <> 'reel')
);
create index creatives_client_status_idx on public.creatives (client_id, status, created_at);
create unique index creatives_external_ref_idx on public.creatives (client_id, external_ref) where external_ref is not null;

create table public.decisions (
  id bigint generated always as identity primary key,
  creative_id uuid not null references public.creatives(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  action text not null check (action in ('approve','reject','adjust','undo')),
  comment text,
  via text not null default 'portal' check (via in ('portal','admin')),
  created_at timestamptz not null default now()
);
create index decisions_creative_idx on public.decisions (creative_id, created_at);

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  creative_id uuid not null unique references public.creatives(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete set null,
  status text not null default 'scheduled'
    check (status in ('scheduled','processing','published','failed','canceled')),
  scheduled_for timestamptz not null,
  container_id text,
  container_created_at timestamptz,
  media_id text,
  permalink text,
  published_at timestamptz,
  attempts int not null default 0,
  last_error text,
  is_example boolean not null default false,
  created_at timestamptz not null default now()
);
create index posts_due_idx on public.posts (status, scheduled_for);
create index posts_client_idx on public.posts (client_id, status);

create table public.post_metrics (
  post_id uuid primary key references public.posts(id) on delete cascade,
  views int,
  reach int,
  likes int,
  comments int,
  saved int,
  shares int,
  total_interactions int,
  avg_watch_time_ms int,
  fetched_at timestamptz not null default now()
);

-- ---------- Seguranca: RLS ligado, sem policies, sem grants para anon/authenticated ----------
do $$
declare t text;
begin
  foreach t in array array['clients','agents','portal_links','api_keys','settings','social_accounts',
                           'oauth_states','creatives','decisions','posts','post_metrics']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ---------- Tokens do Instagram no Vault (criptografados em repouso) ----------
create or replace function public.ig_token_store(p_account_id uuid, p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  select token_secret_id into v_secret from public.social_accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_token, 'ig_token_' || p_account_id::text, 'Instagram long-lived token');
    update public.social_accounts set token_secret_id = v_secret where id = p_account_id;
  else
    perform vault.update_secret(v_secret, p_token);
  end if;
end $$;

create or replace function public.ig_token_read(p_account_id uuid)
returns text language sql security definer set search_path = '' as $$
  select s.decrypted_secret
  from public.social_accounts a
  join vault.decrypted_secrets s on s.id = a.token_secret_id
  where a.id = p_account_id;
$$;

create or replace function public.ig_token_delete(p_account_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret uuid;
begin
  select token_secret_id into v_secret from public.social_accounts where id = p_account_id;
  if v_secret is not null then
    update public.social_accounts set token_secret_id = null where id = p_account_id;
    delete from vault.secrets where id = v_secret;
  end if;
end $$;

-- ---------- Proximo horario livre do agente ----------
create or replace function public.next_free_slot(p_client_id uuid, p_after timestamptz default now())
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_times text[];
  v_slot timestamptz;
begin
  select c.timezone, a.post_times into v_tz, v_times
  from public.clients c left join public.agents a on a.client_id = c.id
  where c.id = p_client_id;
  if v_times is null or cardinality(v_times) = 0 then
    return p_after;
  end if;
  select s.slot into v_slot
  from (
    select ((d::date + t::time) at time zone v_tz) as slot
    from generate_series((p_after at time zone v_tz)::date, (p_after at time zone v_tz)::date + 90, interval '1 day') d
    cross join unnest(v_times) t
  ) s
  where s.slot > p_after + interval '10 minutes'
    and not exists (
      select 1 from public.posts p
      where p.client_id = p_client_id
        and p.status in ('scheduled','processing')
        and p.scheduled_for = s.slot
    )
  order by s.slot
  limit 1;
  return coalesce(v_slot, p_after);
end $$;

-- ---------- Decisao do cliente (atomica) ----------
create or replace function public.portal_decide(
  p_client_id uuid, p_creative_id uuid, p_action text, p_comment text default null, p_via text default 'portal'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.creatives%rowtype;
  v_when timestamptz;
  v_account uuid;
begin
  if p_action not in ('approve','reject','adjust') then
    raise exception 'invalid action';
  end if;
  select * into c from public.creatives
  where id = p_creative_id and client_id = p_client_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if c.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_decided', 'status', c.status);
  end if;
  if p_action = 'adjust' and coalesce(btrim(p_comment), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'comment_required');
  end if;

  update public.creatives set
    status = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'adjust' end,
    decision_comment = nullif(btrim(coalesce(p_comment, '')), ''),
    decided_at = now()
  where id = c.id;

  insert into public.decisions (creative_id, client_id, action, comment, via)
  values (c.id, p_client_id, p_action, nullif(btrim(coalesce(p_comment, '')), ''), p_via);

  if p_action = 'approve' then
    if c.suggested_at is not null and c.suggested_at > now() + interval '5 minutes' then
      v_when := c.suggested_at;
    else
      v_when := public.next_free_slot(p_client_id, now());
    end if;
    select id into v_account from public.social_accounts
    where client_id = p_client_id and platform = 'instagram';
    insert into public.posts (creative_id, client_id, social_account_id, scheduled_for)
    values (c.id, p_client_id, v_account, v_when)
    on conflict (creative_id) do update
      set status = 'scheduled', scheduled_for = excluded.scheduled_for,
          social_account_id = excluded.social_account_id, attempts = 0, last_error = null;
  end if;

  return jsonb_build_object('ok', true, 'status',
    case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'adjust' end,
    'scheduled_for', v_when);
end $$;

-- ---------- Desfazer (so enquanto o post nao comecou a ser publicado) ----------
create or replace function public.portal_undo(p_client_id uuid, p_creative_id uuid, p_via text default 'portal')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.creatives%rowtype;
  v_post_status text;
begin
  select * into c from public.creatives
  where id = p_creative_id and client_id = p_client_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if c.status not in ('approved','rejected','adjust') then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_undo');
  end if;
  select status into v_post_status from public.posts where creative_id = c.id for update;
  if v_post_status in ('processing','published') then
    return jsonb_build_object('ok', false, 'error', 'already_publishing');
  end if;
  delete from public.posts where creative_id = c.id;
  update public.creatives set status = 'pending', decision_comment = null, decided_at = null where id = c.id;
  insert into public.decisions (creative_id, client_id, action, via) values (c.id, p_client_id, 'undo', p_via);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Worker: reserva posts vencidos sem corrida entre execucoes ----------
create or replace function public.worker_claim_due(p_limit int default 8)
returns setof public.posts language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.posts p set status = 'processing', attempts = p.attempts + 1
  where p.id in (
    select p2.id from public.posts p2
    join public.social_accounts a on a.client_id = p2.client_id and a.platform = 'instagram' and a.status = 'connected'
    where p2.status = 'scheduled' and p2.scheduled_for <= now() and p2.is_example = false
    order by p2.scheduled_for
    limit p_limit
    for update of p2 skip locked
  )
  returning p.*;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'ig_token_store(uuid, text)','ig_token_read(uuid)','ig_token_delete(uuid)',
    'next_free_slot(uuid, timestamptz)','portal_decide(uuid, uuid, text, text, text)',
    'portal_undo(uuid, uuid, text)','worker_claim_due(int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- ---------- Storage: bucket publico (o Instagram precisa baixar a midia por URL publica) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creatives', 'creatives', true, 52428800,
        array['video/mp4','video/quicktime','image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- ---------- Segredo do worker ----------
insert into public.settings (key, value)
values ('worker_secret', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;
