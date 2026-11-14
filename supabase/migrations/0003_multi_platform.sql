-- Conector multi-cliente e multi-plataforma: Instagram (Meta) e TikTok (provedor), carrossel, localizacao e audio.
-- Um criativo aprovado gera um post por plataforma de destino.

-- Remove checks antigos de forma independente do nome gerado.
do $$
declare r record;
begin
  for r in
    select conrelid::regclass as tbl, conname from pg_constraint
    where contype = 'c' and (
      (conrelid = 'public.creatives'::regclass and (pg_get_constraintdef(oid) ilike '%kind%' or pg_get_constraintdef(oid) ilike '%format%'))
      or (conrelid = 'public.social_accounts'::regclass and pg_get_constraintdef(oid) ilike '%platform%')
    )
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- ---------- Contas ----------
alter table public.social_accounts
  add constraint social_accounts_platform_check check (platform in ('instagram','tiktok')),
  add column if not exists provider text not null default 'meta' check (provider in ('meta','uploadpost')),
  add column if not exists provider_ref text;

-- ---------- Criativos ----------
alter table public.creatives
  add column if not exists media jsonb not null default '[]'::jsonb,
  add column if not exists platforms text[] not null default '{instagram}',
  add column if not exists location_id text,
  add column if not exists location_name text,
  add column if not exists audio_name text,
  add column if not exists auto_music boolean not null default false,
  add constraint creatives_kind_check check (kind in ('video','image','carousel')),
  add constraint creatives_format_check check (format in ('reel','feed','story')),
  add constraint creatives_shape_check check (
    (format = 'reel' and kind = 'video')
    or (format = 'feed' and kind in ('image','carousel'))
    or (format = 'story' and kind in ('image','video'))
  ),
  add constraint creatives_platforms_check check (platforms <@ array['instagram','tiktok']::text[] and cardinality(platforms) >= 1);

comment on column public.creatives.media is 'Itens do carrossel: [{kind, url, path, thumb}]. Vazio para midia unica (usa media_url).';
comment on column public.creatives.location_id is 'ID da Pagina do Facebook do local (parametro location_id da API do Instagram).';
comment on column public.creatives.audio_name is 'Nome do audio original do Reel (a API so renomeia audio original; nao escolhe musica da biblioteca).';

-- ---------- Posts: um por plataforma ----------
alter table public.posts
  add column if not exists platform text not null default 'instagram' check (platform in ('instagram','tiktok'));
alter table public.posts drop constraint if exists posts_creative_id_key;
alter table public.posts add constraint posts_creative_platform_key unique (creative_id, platform);
comment on column public.posts.container_id is 'Referencia do job no provedor: container da Meta ou request_id do Upload-Post.';

-- ---------- Pedidos de exclusao de dados (callback da Meta) ----------
create table if not exists public.deletion_requests (
  code text primary key,
  platform text not null default 'meta',
  accounts_removed int not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table public.deletion_requests enable row level security;
revoke all on public.deletion_requests from anon, authenticated;

-- ---------- Decisao: cria um post por plataforma ----------
create or replace function public.portal_decide(
  p_client_id uuid, p_creative_id uuid, p_action text, p_comment text default null, p_via text default 'portal'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.creatives%rowtype;
  v_when timestamptz;
  v_platform text;
  v_account uuid;
  v_targets text[] := '{}';
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
    foreach v_platform in array c.platforms loop
      -- O TikTok nao tem stories.
      continue when v_platform = 'tiktok' and c.format = 'story';
      select id into v_account from public.social_accounts
      where client_id = p_client_id and platform = v_platform;
      insert into public.posts (creative_id, client_id, platform, social_account_id, scheduled_for)
      values (c.id, p_client_id, v_platform, v_account, v_when)
      on conflict (creative_id, platform) do update
        set status = 'scheduled', scheduled_for = excluded.scheduled_for,
            social_account_id = excluded.social_account_id, attempts = 0, last_error = null;
      v_targets := v_targets || v_platform;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'status',
    case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'adjust' end,
    'scheduled_for', v_when, 'platforms', to_jsonb(v_targets));
end $$;

-- ---------- Desfazer: so se nenhuma plataforma comecou a publicar ----------
create or replace function public.portal_undo(p_client_id uuid, p_creative_id uuid, p_via text default 'portal')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.creatives%rowtype;
begin
  select * into c from public.creatives
  where id = p_creative_id and client_id = p_client_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if c.status not in ('approved','rejected','adjust') then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_undo');
  end if;
  perform 1 from public.posts where creative_id = c.id for update;
  if exists (select 1 from public.posts where creative_id = c.id and status in ('processing','published')) then
    return jsonb_build_object('ok', false, 'error', 'already_publishing');
  end if;
  delete from public.posts where creative_id = c.id;
  update public.creatives set status = 'pending', decision_comment = null, decided_at = null where id = c.id;
  insert into public.decisions (creative_id, client_id, action, via) values (c.id, p_client_id, 'undo', p_via);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Worker: so reserva posts cuja conta da mesma plataforma esta conectada ----------
create or replace function public.worker_claim_due(p_limit int default 8)
returns setof public.posts language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.posts p set status = 'processing', attempts = p.attempts + 1
  where p.id in (
    select p2.id from public.posts p2
    join public.social_accounts a on a.client_id = p2.client_id and a.platform = p2.platform and a.status = 'connected'
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
  foreach f in array array['portal_decide(uuid, uuid, text, text, text)','portal_undo(uuid, uuid, text)','worker_claim_due(int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
