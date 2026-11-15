-- Opcoes por criativo (story, legenda, musica, local), link, andamento, chave de ingestao por cliente,
-- espacamento e limite de publicacoes por conta, e isolamento entre clientes garantido pelo banco.
-- Migracao so aditiva: nao remove nem altera restricoes existentes.

-- ---------- Criativos: link e opcoes ----------
alter table public.creatives
  add column if not exists link_url text,
  add column if not exists opt_story boolean not null default false,
  add column if not exists opt_caption boolean not null default true,
  add column if not exists opt_location boolean not null default true,
  add column if not exists story_of uuid references public.creatives(id) on delete cascade;
comment on column public.creatives.link_url is 'Link que acompanha o post. Vai no fim da legenda, como texto.';
comment on column public.creatives.opt_story is 'Publicar tambem no story do Instagram (publicacao extra, sem legenda).';
comment on column public.creatives.story_of is 'Criativo de story gerado na aprovacao a partir deste criativo principal (opcao story). Some junto com o principal.';
comment on column public.creatives.opt_caption is 'Publicar com a legenda, o link e as hashtags.';
comment on column public.creatives.opt_location is 'Marcar o local (location_id) no Instagram.';
comment on column public.creatives.auto_music is 'Opcao de musica: no TikTok, musica automatica em posts de foto. O Instagram nao aceita musica pela API.';

create index if not exists creatives_story_of_idx on public.creatives (story_of) where story_of is not null;

-- ---------- Posts: codigo do ultimo erro (para a tela de andamento) ----------
alter table public.posts add column if not exists last_error_code text;

-- ---------- Isolamento: um post so pode apontar para criativo e conta do mesmo cliente ----------
alter table public.social_accounts add constraint social_accounts_id_client_key unique (id, client_id);
alter table public.creatives add constraint creatives_id_client_key unique (id, client_id);
alter table public.posts add constraint posts_account_same_client_fkey
  foreign key (social_account_id, client_id) references public.social_accounts (id, client_id)
  on delete set null (social_account_id);
alter table public.posts add constraint posts_creative_same_client_fkey
  foreign key (creative_id, client_id) references public.creatives (id, client_id) on delete cascade;

-- ---------- Contas: pausa pedida pela rede e conta simulada (so em cliente de demonstracao) ----------
alter table public.social_accounts
  add column if not exists cooldown_until timestamptz,
  add column if not exists spam_strikes int not null default 0,
  add column if not exists simulated boolean not null default false;
comment on column public.social_accounts.cooldown_until is 'A conta nao publica ate este horario (pausa apos suspeita de spam ou bloqueio temporario da rede).';
comment on column public.social_accounts.simulated is 'Conta de demonstracao: o worker simula a publicacao e nao chama nenhuma rede.';

create or replace function public.social_accounts_sim_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.simulated and not exists (select 1 from public.clients c where c.id = new.client_id and c.is_demo) then
    raise exception 'Conta simulada so pode existir em cliente de demonstracao.';
  end if;
  return new;
end $$;
create or replace trigger social_accounts_sim_guard before insert or update on public.social_accounts
  for each row execute function public.social_accounts_sim_guard();

-- ---------- Chaves: chave de ingestao presa a um cliente ----------
alter table public.api_keys add column if not exists client_id uuid references public.clients(id) on delete cascade;
comment on column public.api_keys.client_id is 'Quando preenchido, a chave so envia criativos para este cliente.';

-- ---------- Ritmo de publicacao (politica do Sr. Post, por conta) ----------
insert into public.settings (key, value) values ('publish_min_gap_minutes', '15'), ('publish_daily_cap', '12')
on conflict (key) do nothing;

-- Primeiro horario em que a conta pode publicar de novo: respeita a pausa pedida pela rede,
-- o intervalo minimo desde a ultima publicacao e o teto de publicacoes em 24 horas.
create or replace function public.account_next_allowed(p_client_id uuid, p_platform text)
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
declare
  v_gap int := coalesce((select nullif(value, '')::int from public.settings where key = 'publish_min_gap_minutes'), 15);
  v_cap int := coalesce((select nullif(value, '')::int from public.settings where key = 'publish_daily_cap'), 12);
  v_cool timestamptz;
  v_last timestamptz;
  v_cap_at timestamptz;
begin
  select cooldown_until into v_cool from public.social_accounts where client_id = p_client_id and platform = p_platform;
  select max(greatest(coalesce(published_at, '-infinity'), coalesce(container_created_at, '-infinity'))) into v_last
  from public.posts
  where client_id = p_client_id and platform = p_platform and is_example = false and status in ('processing','published');
  if v_last = '-infinity' then v_last := null; end if;
  -- Com o teto atingido, a proxima vaga abre 24 horas depois da publicacao que ocupa a posicao do teto.
  select t.at + interval '24 hours' into v_cap_at from (
    select coalesce(published_at, container_created_at) as at
    from public.posts
    where client_id = p_client_id and platform = p_platform and is_example = false and status in ('processing','published')
      and coalesce(published_at, container_created_at) > now() - interval '24 hours'
    order by 1 desc offset greatest(v_cap - 1, 0) limit 1
  ) t;
  return greatest(now(), coalesce(v_cool, '-infinity'), coalesce(v_last + make_interval(mins => v_gap), '-infinity'), coalesce(v_cap_at, '-infinity'));
end $$;

-- Worker: no maximo um post por conta a cada ciclo, e so quando a conta ja pode publicar.
create or replace function public.worker_claim_due(p_limit int default 8)
returns setof public.posts language plpgsql security definer set search_path = '' as $$
begin
  return query
  with pick as (
    select distinct on (a.id) p2.id
    from public.posts p2
    join public.social_accounts a on a.client_id = p2.client_id and a.platform = p2.platform and a.status = 'connected'
    join public.creatives cr on cr.id = p2.creative_id
    where p2.status = 'scheduled' and p2.scheduled_for <= now() and p2.is_example = false
      and public.account_next_allowed(p2.client_id, p2.platform) <= now()
    order by a.id, p2.scheduled_for, (cr.story_of is not null), p2.created_at
  )
  update public.posts p set status = 'processing', attempts = p.attempts + 1
  where p.id in (select id from pick limit p_limit) and p.status = 'scheduled'
  returning p.*;
end $$;

-- Trava do worker: com ciclo de 1 minuto, impede duas execucoes ao mesmo tempo.
create or replace function public.worker_try_lock(p_ttl_seconds int default 170)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.settings (key, value) values ('worker_lock', now()::text)
  on conflict (key) do update set value = now()::text
    where public.settings.value::timestamptz < now() - make_interval(secs => p_ttl_seconds);
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ---------- Decisao: aplica as opcoes escolhidas e cria as publicacoes ----------
create or replace function public.portal_decide_opts(
  p_client_id uuid, p_creative_id uuid, p_action text, p_comment text, p_via text, p_options jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.creatives%rowtype;
  v_when timestamptz;
  v_platform text;
  v_account uuid;
  v_targets text[] := '{}';
  v_story boolean := false;
  v_child uuid;
begin
  if p_action not in ('approve','reject','adjust') then
    raise exception 'invalid action';
  end if;
  select * into c from public.creatives
  where id = p_creative_id and client_id = p_client_id and story_of is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if c.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_decided', 'status', c.status);
  end if;
  if p_action = 'adjust' and coalesce(btrim(p_comment), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'comment_required');
  end if;

  -- As opcoes chegam ja validadas pela API (o que a rede nao aceita vem desligado).
  if p_action = 'approve' and p_options is not null then
    c.opt_story := coalesce((p_options->>'story')::boolean, c.opt_story);
    c.opt_caption := coalesce((p_options->>'caption')::boolean, c.opt_caption);
    c.auto_music := coalesce((p_options->>'music')::boolean, c.auto_music);
    c.opt_location := coalesce((p_options->>'location')::boolean, c.opt_location);
  end if;

  update public.creatives set
    status = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'adjust' end,
    decision_comment = nullif(btrim(coalesce(p_comment, '')), ''),
    decided_at = now(),
    opt_story = c.opt_story, opt_caption = c.opt_caption, auto_music = c.auto_music, opt_location = c.opt_location
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
            social_account_id = excluded.social_account_id, attempts = 0, last_error = null, last_error_code = null;
      v_targets := v_targets || v_platform;
      -- Copia no story do Instagram: criativo filho, sem legenda, com a primeira midia. Sai depois do post
      -- principal (o worker respeita o intervalo minimo da conta).
      if v_platform = 'instagram' and c.opt_story and c.format <> 'story'
         and not exists (select 1 from public.creatives s where s.story_of = c.id) then
        insert into public.creatives (client_id, kind, format, media_url, thumb_url, title, caption, hashtags, platforms,
          ai_generated, suggested_at, status, decided_at, source, story_of)
        values (p_client_id,
          case when c.kind = 'carousel' then coalesce(c.media->0->>'kind', 'image') else c.kind end, 'story',
          case when c.kind = 'carousel' then coalesce(c.media->0->>'url', c.media_url) else c.media_url end,
          case when c.kind = 'carousel' then c.media->0->>'thumb' else c.thumb_url end,
          c.title, '', '', array['instagram'], c.ai_generated, c.suggested_at, 'approved', now(), c.source, c.id)
        returning id into v_child;
        insert into public.posts (creative_id, client_id, platform, social_account_id, scheduled_for)
        values (v_child, p_client_id, 'instagram', v_account, v_when);
        v_story := true;
      end if;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'status',
    case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'adjust' end,
    'scheduled_for', v_when, 'platforms', to_jsonb(v_targets), 'story', v_story);
end $$;

-- Assinatura antiga mantida: decide sem alterar as opcoes do criativo.
create or replace function public.portal_decide(
  p_client_id uuid, p_creative_id uuid, p_action text, p_comment text default null, p_via text default 'portal'
) returns jsonb language sql security definer set search_path = '' as $$
  select public.portal_decide_opts(p_client_id, p_creative_id, p_action, p_comment, p_via, null);
$$;

-- ---------- Desfazer: remove tambem o story gerado na aprovacao ----------
create or replace function public.portal_undo(p_client_id uuid, p_creative_id uuid, p_via text default 'portal')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.creatives%rowtype;
begin
  select * into c from public.creatives
  where id = p_creative_id and client_id = p_client_id and story_of is null for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if c.status not in ('approved','rejected','adjust') then
    return jsonb_build_object('ok', false, 'error', 'nothing_to_undo');
  end if;
  perform 1 from public.posts
  where creative_id = c.id or creative_id in (select s.id from public.creatives s where s.story_of = c.id) for update;
  if exists (
    select 1 from public.posts
    where (creative_id = c.id or creative_id in (select s.id from public.creatives s where s.story_of = c.id))
      and status in ('processing','published')
  ) then
    return jsonb_build_object('ok', false, 'error', 'already_publishing');
  end if;
  delete from public.posts where creative_id = c.id;
  delete from public.creatives where story_of = c.id;
  update public.creatives set status = 'pending', decision_comment = null, decided_at = null where id = c.id;
  insert into public.decisions (creative_id, client_id, action, via) values (c.id, p_client_id, 'undo', p_via);
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'portal_decide_opts(uuid, uuid, text, text, text, jsonb)','portal_decide(uuid, uuid, text, text, text)','worker_claim_due(int)',
    'account_next_allowed(uuid, text)','worker_try_lock(int)','portal_undo(uuid, uuid, text)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
