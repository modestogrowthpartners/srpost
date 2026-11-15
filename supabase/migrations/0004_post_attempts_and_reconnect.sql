-- Historico de tentativas de publicacao (nada e apagado) e redistribuicao de posts atrasados na reconexao.

create table if not exists public.post_attempts (
  id bigint generated always as identity primary key,
  post_id uuid not null references public.posts(id) on delete cascade,
  attempt int not null,
  phase text not null check (phase in ('start','publish')),
  outcome text not null check (outcome in ('ok','retry','failed','reconnect')),
  error text,
  error_code text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists post_attempts_post_idx on public.post_attempts (post_id, created_at);
alter table public.post_attempts enable row level security;
revoke all on public.post_attempts from anon, authenticated;

comment on column public.posts.last_error is 'Ultimo erro registrado. Nao e apagado quando o post e publicado; o historico completo fica em post_attempts.';

-- Ao reconectar uma conta, os posts que ficaram parados nao saem todos de uma vez:
-- o mais antigo vai no proximo ciclo e os demais ocupam os proximos horarios livres do agente
-- (ou ficam espacados em 30 minutos quando o agente nao tem horarios fixos).
create or replace function public.respread_overdue(p_client_id uuid, p_platform text)
returns int language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_when timestamptz := now();
  v_has_slots boolean;
  n int := 0;
begin
  select cardinality(coalesce(a.post_times, '{}')) > 0 into v_has_slots
  from public.agents a where a.client_id = p_client_id;
  for r in
    select id from public.posts
    where client_id = p_client_id and platform = p_platform and status = 'scheduled'
      and scheduled_for < now() - interval '30 minutes'
    order by scheduled_for, created_at
  loop
    if n = 0 then
      v_when := now();
    elsif coalesce(v_has_slots, false) then
      v_when := public.next_free_slot(p_client_id, v_when);
    else
      v_when := v_when + interval '30 minutes';
    end if;
    update public.posts set scheduled_for = v_when where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.respread_overdue(uuid, text) from public, anon, authenticated;
grant execute on function public.respread_overdue(uuid, text) to service_role;
