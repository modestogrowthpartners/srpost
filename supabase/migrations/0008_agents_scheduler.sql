-- Agendadores no pg_cron, de forma repetivel (um projeto novo ou restaurado fica com os dois jobs),
-- e isolamento por cliente nas execucoes dos agentes. Migracao so aditiva.

-- ---------- Agendadores: publicador e motor dos agentes, a cada minuto ----------
-- Cada um tem a propria rota e a propria trava, para um ciclo lento de geracao nao atrasar a publicacao.
-- cron.schedule com um nome que ja existe atualiza o job: rodar de novo nao duplica.
select cron.schedule('srpost-worker', '* * * * *', $cron$
  select net.http_post(
    url := (select value from public.settings where key = 'functions_url') || '/worker/tick',
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-worker-secret', (select value from public.settings where key = 'worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$cron$);

-- O motor dos agentes roda na funcao "agents" (endereco guardado em settings.agents_url).
insert into public.settings (key, value)
select 'agents_url', regexp_replace(value, '/api/?$', '/agents') from public.settings where key = 'functions_url'
on conflict (key) do update set value = excluded.value;

select cron.schedule('srpost-agents', '* * * * *', $cron$
  select net.http_post(
    url := (select value from public.settings where key = 'agents_url') || '/tick',
    headers := jsonb_build_object('content-type', 'application/json',
                                  'x-worker-secret', (select value from public.settings where key = 'worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$cron$);

-- ---------- Isolamento: execucao so aponta para agente e criativo do mesmo cliente ----------
alter table public.agents add constraint agents_id_client_key unique (id, client_id);
alter table public.agent_runs add constraint agent_runs_agent_same_client_fkey
  foreign key (agent_id, client_id) references public.agents (id, client_id) on delete cascade;
alter table public.agent_runs add constraint agent_runs_creative_same_client_fkey
  foreign key (creative_id, client_id) references public.creatives (id, client_id) on delete set null (creative_id);
