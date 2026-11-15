-- Central de agentes: configuracao completa do agente, execucoes (runs) com maquina de estados por etapa,
-- eventos reais de cada etapa (base da visao ao vivo e do chat de diagnostico) e historico do chat.
-- Migracao so aditiva. Listas de valores (provedores, modos) sao validadas na API, nao por check,
-- para poderem crescer sem remover restricoes.

-- ---------- Agente: contexto, formatos, automacao e fornecedores ----------
alter table public.agents
  add column if not exists context text,
  add column if not exists audience text,
  add column if not exists formats text[] not null default '{reel,carrossel,imagem}',
  add column if not exists voice jsonb not null default '{}'::jsonb,
  add column if not exists default_link text,
  add column if not exists approval_mode text not null default 'cliente',
  add column if not exists automation text not null default 'pausada',
  add column if not exists text_provider text not null default 'claude',
  add column if not exists media_provider text not null default 'manual',
  add column if not exists story_default boolean not null default false,
  add column if not exists ai_label boolean not null default true,
  add column if not exists lead_hours int not null default 24 check (lead_hours between 1 and 168),
  add column if not exists config_version int not null default 1,
  add column if not exists last_run_at timestamptz;
comment on column public.agents.context is 'Contexto da conta: o que a marca faz, o que vende, diferenciais. Base de todo o conteudo gerado.';
comment on column public.agents.formats is 'Tipos de postagem que o agente produz: reel, carrossel, imagem, story.';
comment on column public.agents.voice is 'Voz da marca: palavras que usa, palavras proibidas, chamada para acao, provas que pode citar, temas proibidos.';
comment on column public.agents.approval_mode is 'cliente = cada post espera o sim do cliente no portal; automatica = o agente aprova sozinho.';
comment on column public.agents.automation is 'ligada = o agendador gera conteudo sozinho para os proximos horarios; pausada = so roda quando o time manda.';
comment on column public.agents.text_provider is 'Quem escreve plano, roteiro e copy: claude ou simulado (so demonstracao).';
comment on column public.agents.media_provider is 'Quem gera imagem e video: manual (o time envia a midia), simulado (so demonstracao) ou um gerador externo.';
comment on column public.agents.lead_hours is 'Com quantas horas de antecedencia o agente prepara o post de cada horario.';

-- ---------- Execucoes: um post sendo produzido, etapa por etapa ----------
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  trigger text not null default 'agenda',
  status text not null default 'rodando',
  step text not null default 'planejar',
  slot_at timestamptz,
  format text,
  data jsonb not null default '{}'::jsonb,
  creative_id uuid references public.creatives(id) on delete set null,
  revision int not null default 0,
  attempts int not null default 0,
  error text,
  error_code text,
  simulated boolean not null default false,
  next_step_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
comment on table public.agent_runs is 'Uma execucao do agente = um post em producao. step: planejar, roteiro, copy, midia, aprovacao, publicar. status: rodando, aguardando_midia, aguardando_aprovacao, publicando, concluido, falhou, cancelado.';
create unique index if not exists agent_runs_slot_idx on public.agent_runs (agent_id, slot_at) where slot_at is not null and status <> 'cancelado';
create index if not exists agent_runs_due_idx on public.agent_runs (status, next_step_at);
create index if not exists agent_runs_client_idx on public.agent_runs (client_id, started_at desc);
create index if not exists agent_runs_creative_idx on public.agent_runs (creative_id) where creative_id is not null;

-- ---------- Eventos: o que realmente aconteceu em cada etapa ----------
create table if not exists public.agent_events (
  id bigint generated always as identity primary key,
  run_id uuid references public.agent_runs(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  step text not null,
  status text not null,
  message text,
  detail jsonb,
  duration_ms int,
  created_at timestamptz not null default now()
);
comment on table public.agent_events is 'Linha do tempo real do agente. status: iniciou, ok, falhou, aguardando, pulou, info. A visao ao vivo e o chat de diagnostico leem daqui.';
create index if not exists agent_events_client_idx on public.agent_events (client_id, id desc);
create index if not exists agent_events_run_idx on public.agent_events (run_id, id);

-- ---------- Chat de diagnostico: perguntas do time e o que foi consultado ----------
create table if not exists public.diag_chats (
  id bigint generated always as identity primary key,
  question text not null,
  answer text,
  mode text not null default 'regras',
  tools jsonb not null default '[]'::jsonb,
  duration_ms int,
  error text,
  created_at timestamptz not null default now()
);
comment on table public.diag_chats is 'Historico do chat de diagnostico (somente leitura sobre agentes, automacoes e logs). mode: claude ou regras.';

alter table public.agent_runs enable row level security;
alter table public.agent_events enable row level security;
alter table public.diag_chats enable row level security;
revoke all on public.agent_runs, public.agent_events, public.diag_chats from anon, authenticated;

-- ---------- Trava generica: cada agendador (publicador, agentes) tem a sua ----------
create or replace function public.try_lock(p_key text, p_ttl_seconds int default 170)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.settings (key, value) values (p_key, now()::text)
  on conflict (key) do update set value = now()::text
    where public.settings.value::timestamptz < now() - make_interval(secs => p_ttl_seconds);
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.try_lock(text, int) from public, anon, authenticated;
grant execute on function public.try_lock(text, int) to service_role;
