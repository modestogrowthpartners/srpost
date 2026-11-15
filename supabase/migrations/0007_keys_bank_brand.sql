-- Chaves coladas no painel (guardadas criptografadas no Vault), banco de pautas do agente,
-- identidade visual para a arte por template e cache de arquivos estaticos da renderizacao.
-- Migracao so aditiva.

-- ---------- Chaves dos fornecedores coladas no painel ----------
-- O valor nunca volta para o painel: a API so informa se a chave existe e o resultado do teste.
create or replace function public.panel_secret_set(p_name text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_name !~ '^[A-Z][A-Z0-9_]{2,60}$' then raise exception 'invalid secret name'; end if;
  select id into v_id from vault.secrets where name = 'panel_' || p_name;
  if v_id is null then
    perform vault.create_secret(p_value, 'panel_' || p_name, 'Chave colada no painel do Sr. Post');
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end $$;

create or replace function public.panel_secrets_read()
returns table (name text, value text) language sql security definer set search_path = '' as $$
  select substr(s.name, 7), s.decrypted_secret from vault.decrypted_secrets s where s.name like 'panel\_%' escape '\';
$$;

create or replace function public.panel_secret_clear(p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where name = 'panel_' || p_name;
end $$;

-- ---------- Identidade visual do agente (cores e assinatura da arte por template) ----------
alter table public.agents add column if not exists brand jsonb not null default '{}'::jsonb;
comment on column public.agents.brand is 'Arte por template: { tema, fundo, texto, destaque, assinatura }. Vazio = tema padrao.';

-- ---------- Banco de pautas: posts ja escritos que o agente usa sem depender de modelo de linguagem ----------
create table if not exists public.content_bank (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  status text not null default 'disponivel',
  formato text not null,
  tema text not null,
  pilar text,
  plan jsonb not null,
  script jsonb not null,
  copy jsonb not null,
  note text,
  used_run_id uuid,
  used_at timestamptz,
  position int not null default 0,
  created_at timestamptz not null default now()
);
comment on table public.content_bank is 'Pautas prontas do agente (plano, roteiro e copy ja escritos). status: disponivel, usado, repetido. O agente consome uma por post, sem repetir.';
create index if not exists content_bank_next_idx on public.content_bank (client_id, status, position, created_at);

-- ---------- Arquivos estaticos da renderizacao (fontes), para nao depender de rede a cada inicio ----------
create table if not exists public.assets (
  key text primary key,
  content text not null,
  updated_at timestamptz not null default now()
);
comment on table public.assets is 'Cache de arquivos estaticos em base64 (fontes da arte por template).';

alter table public.content_bank enable row level security;
alter table public.assets enable row level security;
revoke all on public.content_bank, public.assets from anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array['panel_secret_set(text, text)', 'panel_secrets_read()', 'panel_secret_clear(text)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
