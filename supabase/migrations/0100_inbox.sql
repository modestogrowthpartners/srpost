-- Caixa de entrada: comentarios e mensagens diretas das contas conectadas.
-- Modulo separado da API principal (Edge Function "inbox"). Tabelas com prefixo inbox_.
-- Regras simples, sem IA: emoji ou elogio curto recebem resposta fixa configuravel,
-- pergunta ou assunto importante vai para a caixa de entrada para uma pessoa responder.

create table if not exists public.inbox_settings (
  client_id uuid primary key references public.clients(id) on delete cascade,
  auto_enabled boolean not null default true,
  emoji_action text not null default 'reply' check (emoji_action in ('reply', 'ignore')),
  emoji_reply text not null default '🙌',
  praise_action text not null default 'reply' check (praise_action in ('reply', 'ignore')),
  praise_reply text not null default 'Valeu! 🙌',
  keyword_rules jsonb not null default '[]'::jsonb,
  daily_cap integer not null default 30 check (daily_cap between 0 and 300),
  -- So responde sozinho comentarios feitos depois desta data (nao responde o historico antigo).
  auto_since timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.inbox_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete set null,
  platform text not null check (platform in ('instagram', 'tiktok')),
  kind text not null default 'comment' check (kind in ('comment', 'dm')),
  external_id text not null,
  media_id text,
  media_permalink text,
  media_caption text,
  author_id text,
  author_name text,
  text text not null default '',
  created_at_platform timestamptz,
  category text not null default 'other' check (category in ('emoji', 'praise', 'question', 'attention', 'mention', 'keyword', 'other')),
  status text not null default 'pending' check (status in ('pending', 'auto_replied', 'replied', 'done', 'hidden', 'error')),
  reply_text text,
  replied_at timestamptz,
  replied_by text check (replied_by in ('auto', 'portal', 'admin')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);
create index if not exists inbox_items_client_status on public.inbox_items (client_id, status, created_at_platform desc);

-- Ultima contagem de comentarios vista por midia, para so buscar o que mudou.
create table if not exists public.inbox_media_state (
  social_account_id uuid not null references public.social_accounts(id) on delete cascade,
  media_id text not null,
  comments_count integer not null default 0,
  checked_at timestamptz not null default now(),
  primary key (social_account_id, media_id)
);

-- Registro de cada rodada, para diagnostico no painel.
create table if not exists public.inbox_runs (
  id bigint generated always as identity primary key,
  social_account_id uuid references public.social_accounts(id) on delete cascade,
  started_at timestamptz not null default now(),
  fetched integer not null default 0,
  new_items integer not null default 0,
  auto_replies integer not null default 0,
  error text
);
create index if not exists inbox_runs_recent on public.inbox_runs (social_account_id, started_at desc);

do $$
declare t text;
begin
  foreach t in array array['inbox_settings', 'inbox_items', 'inbox_media_state', 'inbox_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

insert into public.settings (key, value)
values ('inbox_url', 'https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/inbox')
on conflict (key) do nothing;

-- Token de verificacao do webhook da Meta (aparece no painel do time para colar na Meta).
insert into public.settings (key, value)
values ('inbox_verify_token', encode(extensions.gen_random_bytes(16), 'hex'))
on conflict (key) do nothing;

-- Rodada a cada 2 minutos.
select cron.unschedule('srpost-inbox') where exists (select 1 from cron.job where jobname = 'srpost-inbox');
select cron.schedule('srpost-inbox', '*/2 * * * *', $cron$
  select net.http_post(
    url := (select value from public.settings where key = 'inbox_url') || '/tick',
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-worker-secret', (select value from public.settings where key = 'worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
$cron$);
