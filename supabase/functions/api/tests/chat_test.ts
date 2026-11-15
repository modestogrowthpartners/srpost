// Testes do chat de diagnostico (lib/chat.ts). Nada aqui fala com servico real:
//   - o Claude e um servidor de mentira em 127.0.0.1 (ANTHROPIC_BASE_URL);
//   - o banco e um acesso aos dados em memoria (o cliente do Supabase aponta para uma porta fechada e nunca e chamado).
// Rodar em supabase/functions/api:
//   deno test --allow-net=127.0.0.1 --allow-env --allow-read tests/chat_test.ts
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:9");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
Deno.env.delete("ANTHROPIC_API_KEY");
Deno.env.delete("ANTHROPIC_BASE_URL");
Deno.env.delete("CLAUDE_MODEL");

const chat = await import("../lib/chat.ts");
const core = await import("../lib/core.ts");
type DataAccess = import("../lib/chat.ts").DataAccess;
type ToolExec = import("../lib/chat.ts").ToolExec;
type ChatStore = import("../lib/chat.ts").ChatStore;

// deno-lint-ignore no-explicit-any
type Row = any;

// ---------- Apoio ----------
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Falhou: ${msg}`);
}
function eq(got: unknown, want: unknown, msg: string) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`Falhou: ${msg}\n  obtido:   ${a}\n  esperado: ${b}`);
}
const has = (text: string, part: string, msg?: string) => assert(text.includes(part), msg ?? `o texto deveria conter "${part}"\n---\n${text}\n---`);
const lacks = (text: string, part: string, msg?: string) => assert(!text.includes(part), msg ?? `o texto nao deveria conter "${part}"\n---\n${text}\n---`);
const LONG_DASH = String.fromCharCode(8212);

type Captured = { path: string; headers: Record<string, string>; body: Row };
type Reply = { status?: number; body: unknown };
// Servidor de mentira da API do Claude: guarda cada requisicao e responde pelo roteiro do teste.
async function withFake(script: (req: Captured, n: number) => Reply, fn: (requests: Captured[]) => Promise<void>) {
  const requests: Captured[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const u = new URL(req.url);
    const cap: Captured = { path: u.pathname + u.search, headers: Object.fromEntries(req.headers), body: await req.json().catch(() => null) };
    requests.push(cap);
    const r = script(cap, requests.length);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", "request-id": "req_teste" } });
  });
  Deno.env.set("ANTHROPIC_BASE_URL", `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`);
  try {
    await fn(requests);
  } finally {
    Deno.env.delete("ANTHROPIC_BASE_URL");
    await server.shutdown();
  }
}
const message = (content: unknown[], stop_reason: string, extra: Record<string, unknown> = {}): Reply => ({
  body: { id: "msg_teste", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 }, ...extra },
});
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const THINKING = { type: "thinking", thinking: "", signature: "assinatura_de_teste" };
const apiError = (status: number, type: string, msg: string): Reply => ({ status, body: { type: "error", error: { type, message: msg } } });

// Executor de mentira: registra as chamadas e devolve texto fixo. fail = ferramentas que dao erro.
function stubExec(fail: string[] = []) {
  const calls: { name: string; input: unknown }[] = [];
  const exec: ToolExec = (name, input) => {
    calls.push({ name, input });
    if (fail.includes(name)) return Promise.reject(new Error(`consulta ${name} indisponivel`));
    return Promise.resolve({ text: `resultado de ${name}`, summary: `resumo de ${name}`, logs: [{ at: "2026-11-15T12:00:00.000Z", client: "Padaria Aurora", step: "copy", status: "falhou", message: `linha de log de ${name}` }] });
  };
  return { exec, calls };
}
const KEY = "chave-de-teste-nao-e-real";
const opt = { apiKey: KEY };

// ---------- Dados em memoria ----------
const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222", C3 = "33333333-3333-4333-8333-333333333333", C4 = "44444444-4444-4444-8444-444444444444";
const R1 = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1", R2 = "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2", R3 = "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3", R4 = "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4", R5 = "aaaaaaa5-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const P6 = "bbbbbbb6-bbbb-4bbb-8bbb-bbbbbbbbbbb6";
const P1 = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1", P2 = "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2", P3 = "bbbbbbb3-bbbb-4bbb-8bbb-bbbbbbbbbbb3", P4 = "bbbbbbb4-bbbb-4bbb-8bbb-bbbbbbbbbbb4", P5 = "bbbbbbb5-bbbb-4bbb-8bbb-bbbbbbbbbbb5";
const CR2 = "ccccccc2-cccc-4ccc-8ccc-ccccccccccc2";
// Valores com cara de segredo espalhados em campos que as ferramentas nao devem ler nem mostrar.
const META_TOKEN = "EAAB" + "x1Y2z3".repeat(8), ADMIN_KEY = "srp_adm_" + "Qw3rTy".repeat(6), HASH = "0123456789abcdef".repeat(4);
const SECRET_MARKS = ["SEGREDO", META_TOKEN, ADMIN_KEY, HASH];

function fixture(now: Date) {
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const agent = (over: Row = {}) => ({
    id: crypto.randomUUID(), name: "Agente Sr. Post", role_line: null, bio: null, tone: "Próximo e direto", pillars: ["Produto", "Bastidores"],
    posts_per_week: 7, post_times: ["12:00", "18:30"], platforms: ["instagram"], status: "ativo", context: "Padaria artesanal de bairro, pães de fermentação natural.",
    audience: "Moradores do bairro", formats: ["reel", "carrossel"], voice: { usa: "linguagem simples", evita: "gírias" }, default_link: "https://exemplo.com.br/pedido",
    approval_mode: "cliente", automation: "ligada", text_provider: "claude", media_provider: "manual", story_default: false, ai_label: true, lead_hours: 24,
    config_version: 3, last_run_at: at(-60), updated_at: at(-600), ...over,
  });
  const account = (over: Row = {}) => ({
    platform: "instagram", provider: "meta", username: "conta", status: "connected", simulated: false, cooldown_until: null, spam_strikes: 0, last_error: null,
    connected_at: at(-9000), updated_at: at(-300),
    // campos que o acesso real nunca seleciona:
    token_secret_id: "SEGREDO-TOKEN-SECRET-ID", provider_ref: "SEGREDO-PROVIDER-REF", external_id: "SEGREDO-EXTERNAL-ID", fb_user_id: "SEGREDO-FB-USER", ...over,
  });
  const clients: Row[] = [
    { id: C1, name: "Padaria Aurora", slug: "padaria-aurora", segment: "Alimentação", status: "active", timezone: "America/Sao_Paulo", is_demo: false, created_at: at(-90000),
      agents: [agent({ platforms: ["instagram", "tiktok"] })],
      social_accounts: [account({ username: "padariaaurora", status: "expired", last_error: `Error validating access token: Session has expired. access_token=${META_TOKEN}`, updated_at: at(-1500) })] },
    { id: C2, name: "Clínica São Lucas", slug: "clinica-sao-lucas", segment: "Saúde", status: "active", timezone: "America/Sao_Paulo", is_demo: false, created_at: at(-80000),
      agents: [agent({ context: "Clínica de check-up e medicina preventiva.", last_run_at: at(-400) })],
      social_accounts: [account({ username: "clinicasaolucas", cooldown_until: at(120), spam_strikes: 2 })] },
    { id: C3, name: "Estúdio Bella", slug: "estudio-bella", segment: null, status: "paused", timezone: "America/Sao_Paulo", is_demo: false, created_at: at(-70000),
      agents: [agent({ status: "pausado", automation: "pausada", context: "", last_run_at: null })], social_accounts: [] },
    { id: C4, name: "Demo Sorveteria", slug: "demo-sorveteria", segment: "Alimentação", status: "active", timezone: "America/Sao_Paulo", is_demo: true, created_at: at(-60000),
      agents: [agent({ automation: "pausada", text_provider: "simulado", media_provider: "simulado" })], social_accounts: [account({ username: "demosorvete", simulated: true })] },
  ];
  const run = (id: string, client_id: string, over: Row = {}) => ({
    id, client_id, agent_id: crypto.randomUUID(), trigger: "agenda", status: "concluido", step: "publicar", slot_at: at(600), format: "reel", revision: 0, attempts: 0,
    error: null, error_code: null, simulated: false, creative_id: null, next_step_at: at(1), started_at: at(-180), updated_at: at(-120), finished_at: null,
    tema: "Pão de fermentação natural", titulo: "Fornada do dia", midia_modo: null,
    data: { media_job: { ref: "SEGREDO-JOB-REF" } }, ...over,
  });
  const runs: Row[] = [
    run(R1, C1, { status: "falhou", step: "copy", attempts: 1, error: "A chave do Claude não está configurada.", error_code: "sem_chave_claude", finished_at: at(-120) }),
    run(R2, C1, { status: "aguardando_midia", step: "midia", midia_modo: "manual", started_at: at(-60), updated_at: at(-50), tema: "Bastidores da madrugada" }),
    run(R3, C2, { status: "falhou", step: "publicar", error: "Uma ou mais redes recusaram o post.", error_code: "publicacao_falhou", creative_id: CR2, started_at: at(-900), updated_at: at(-300), finished_at: at(-300), tema: "Check-up anual" }),
    run(R4, C2, { status: "concluido", started_at: at(-3000), updated_at: at(-2800), finished_at: at(-2800) }),
    run(R5, C1, { status: "falhou", step: "roteiro", error: "Falha antiga fora da janela.", error_code: "etapa_falhou", started_at: at(-15000), updated_at: at(-14900), finished_at: at(-14900) }),
  ];
  let eid = 0;
  const ev = (run_id: string | null, client_id: string, step: string, status: string, msg: string, minutes: number, detail: Row = null) =>
    ({ id: ++eid, run_id, client_id, step, status, message: msg, detail, duration_ms: status === "ok" ? 1800 : null, created_at: at(minutes) });
  const events: Row[] = [
    ev(R1, C1, "planejar", "iniciou", "Escolhendo o tema do post.", -180),
    ev(R1, C1, "planejar", "ok", "Tema: Pão de fermentação natural", -179),
    ev(R1, C1, "roteiro", "ok", "Abertura: O segredo está na espera", -170),
    ev(R1, C1, "copy", "iniciou", "Escrevendo a legenda e as hashtags.", -121),
    ev(R1, C1, "copy", "falhou", "A chave do Claude não está configurada.", -120, { tentativa: 1, definitivo: true, codigo: "sem_chave_claude", access_token: "SEGREDO-NO-DETALHE", usage: { chave: "SEGREDO-USO" } }),
    ev(R2, C1, "midia", "iniciou", "Aguardando o time enviar a mídia deste post.", -50, { provider: "manual", modo: "manual", briefing: "SEGREDO-BRIEFING-LONGO" }),
    ev(R3, C2, "aprovacao", "ok", "Aprovado pelo cliente.", -700),
    ev(R3, C2, "publicar", "falhou", "Instagram: a rede recusou. (#4) Application request limit reached", -300, { post_id: P1, platform: "instagram", codigo: "4/2207051" }),
    ev(null, C2, "config", "info", `Falha ao chamar https://graph.facebook.com/v27.0/me?access_token=${META_TOKEN} com a chave ${ADMIN_KEY} e o hash ${HASH}`, -30),
  ];
  const post = (id: string, client_id: string, over: Row = {}) => ({
    id, client_id, creative_id: crypto.randomUUID(), platform: "instagram", status: "scheduled", scheduled_for: at(180), published_at: null, permalink: null, attempts: 0,
    last_error: null, last_error_code: null, created_at: at(-2000), is_example: false, container_id: "SEGREDO-CONTAINER-ID",
    creatives: { title: "Pão do dia", format: "reel", kind: "video", status: "approved", story_of: null, source: "api", ai_generated: true, opt_story: false, opt_caption: true, auto_music: false, opt_location: true }, ...over,
  });
  const posts: Row[] = [
    post(P1, C2, { status: "failed", creative_id: CR2, scheduled_for: at(-360), attempts: 4, last_error: "(#4) Application request limit reached", last_error_code: "4/2207051", creatives: { title: "Check-up de rotina", format: "feed", kind: "image", status: "approved", story_of: null, source: "api", ai_generated: true, opt_story: false, opt_caption: true, auto_music: false, opt_location: true } }),
    post(P2, C1, {}),
    post(P3, C1, { status: "failed", scheduled_for: at(-1440), attempts: 1, last_error: "Error validating access token: Session has expired", last_error_code: "190/460", creatives: { title: "Fornada de sábado", format: "reel", kind: "video", status: "approved", story_of: null, source: "api", ai_generated: true, opt_story: false, opt_caption: true, auto_music: false, opt_location: true } }),
    post(P4, C2, { status: "published", scheduled_for: at(-3000), published_at: at(-2999), permalink: "https://www.instagram.com/p/abc123/" }),
    post(P5, C1, { status: "failed", scheduled_for: at(-15000), attempts: 3, last_error: "Falha antiga fora da janela.", last_error_code: "network" }),
    // aprovado, passou do horario e continua na fila porque a conta expirou (o publicador devolve o post sem gastar tentativa)
    post(P6, C1, { scheduled_for: at(-90), last_error: "Reconecte a conta para publicar.", last_error_code: "190/460", creatives: { title: "Café da tarde", format: "feed", kind: "image", status: "approved", story_of: null, source: "api", ai_generated: true, opt_story: false, opt_caption: true, auto_music: false, opt_location: true } }),
  ];
  const attempt = (post_id: string, n: number, phase: string, outcome: string, code: string, error: string, minutes: number) =>
    ({ post_id, attempt: n, phase, outcome, error, error_code: code, classe: "suspeita de spam (Meta)", created_at: at(minutes), detail: { conta: { external_id: "SEGREDO-EXTERNAL-ID" } } });
  const attempts: Row[] = [
    attempt(P1, 1, "start", "retry", "4/2207051", "(#4) Application request limit reached", -360),
    attempt(P1, 2, "start", "retry", "4/2207051", "(#4) Application request limit reached", -340),
    attempt(P1, 3, "start", "retry", "4/2207051", "(#4) Application request limit reached", -320),
    attempt(P1, 4, "start", "failed", "4/2207051", "(#4) Application request limit reached", -300),
    attempt(P3, 1, "start", "reconnect", "190/460", "Error validating access token: Session has expired", -1440),
  ];
  const pending: Row[] = [{ client_id: C1 }, { client_id: C1 }, { client_id: C2 }];
  const settings: Record<string, string> = {
    agents_last_run: JSON.stringify({ at: at(-1), ms: 900, version: "2026.11.1", created: 1, steps: 2, observed: 0, deferred: 0, errors: [`copy ${R1}: A chave do Claude não está configurada.`] }),
    worker_last_run: JSON.stringify({ at: at(-20), started: 0, published: 0, metrics: 0, tokens_refreshed: 0, errors: [] }),
    publish_min_gap_minutes: "15", publish_daily_cap: "12",
    // chaves que o chat nunca pode ler:
    worker_secret: "SEGREDO-WORKER-SECRET", ig_login_config_id: "SEGREDO-CONFIG-ID",
  };
  return { clients, runs, events, posts, attempts, pending, settings };
}

// Acesso aos dados de mentira, com os mesmos filtros do real. settings devolve tudo de proposito:
// quem escolhe o que ler e a ferramenta.
function fakeData(now: Date, fx = fixture(now)) {
  const asked: string[] = [];
  const inList = (ids: string[] | undefined, v: string) => !ids || ids.includes(v);
  const d: DataAccess = {
    clients: () => Promise.resolve(fx.clients),
    pending: () => Promise.resolve(fx.pending),
    runs: (f) => Promise.resolve(fx.runs.filter((r) => inList(f.clientIds, r.client_id) && inList(f.status, r.status) && (!f.since || r.updated_at >= f.since))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, f.limit)),
    run: (id) => Promise.resolve(fx.runs.find((r) => r.id === id) ?? null),
    events: (f) => Promise.resolve(fx.events.filter((e) => inList(f.clientIds, e.client_id) && inList(f.status, e.status) && (!f.since || e.created_at >= f.since)
      && (!f.runId || e.run_id === f.runId) && (!f.text || e.message.toLowerCase().includes(f.text.toLowerCase()))).sort((a, b) => b.id - a.id).slice(0, f.limit)),
    posts: (f) => Promise.resolve(fx.posts.filter((p) => inList(f.clientIds, p.client_id) && inList(f.creativeIds, p.creative_id) && inList(f.status, p.status) && (!f.since || p.scheduled_for >= f.since))
      .sort((a, b) => (f.asc ? 1 : -1) * a.scheduled_for.localeCompare(b.scheduled_for)).slice(0, f.limit)),
    post: (id) => Promise.resolve(fx.posts.find((p) => p.id === id) ?? null),
    attempts: (ids) => Promise.resolve(fx.attempts.filter((a) => ids.includes(a.post_id)).sort((a, b) => b.created_at.localeCompare(a.created_at))),
    settings: (keys) => { asked.push(...keys); return Promise.resolve({ ...fx.settings }); },
    providers: () => ({ claude: false, model: "claude-opus-5-5", higgsfield: false, instagram: true, tiktok: false }),
  };
  return { d, asked, fx };
}
const NOW = new Date("2026-11-15T15:00:00.000Z"); // 12:00 em Sao Paulo
const rulesExec = () => chat.makeExec(fakeData(NOW).d, () => NOW);
const names = (r: { tools: { name: string }[] }) => r.tools.map((t) => t.name);

// =====================================================================
// Modo Claude: formato da requisicao e laco de ferramentas
// =====================================================================
Deno.test("claude: formato da requisicao (modelo, ferramentas estritas, thinking, betas, fallbacks, sem temperature nem tool_choice)", async () => {
  await withFake(() => message([THINKING, text("Tudo certo.")], "end_turn"), async (requests) => {
    const { exec, calls } = stubExec();
    const history = [{ role: "user" as const, text: "Como está a Padaria?" }, { role: "assistant" as const, text: "Sem falhas." }];
    const out = await chat.claudeChat("E a Clínica?", history, exec, { ...opt, now: NOW });
    eq(out, { ok: true, text: "Tudo certo.", iterations: 1 }, "resposta final sem ferramenta");
    eq(calls.length, 0, "nenhuma ferramenta chamada");
    eq(requests.length, 1, "uma requisicao");
    const { path, headers, body } = requests[0];
    assert(path.startsWith("/v1/messages"), `caminho ${path}`);
    // O SDK 1.8.0 manda a chave em authorization: Bearer; versoes anteriores usavam x-api-key. Vale qualquer um dos dois.
    assert(headers["authorization"] === `Bearer ${KEY}` || headers["x-api-key"] === KEY, `chave no cabecalho de autenticacao: ${JSON.stringify(Object.keys(headers))}`);
    has(headers["anthropic-beta"] ?? "", "server-side-fallback-2026-07-01");
    eq(body.model, "claude-opus-5-5", "modelo padrao");
    eq(body.thinking, { type: "adaptive" }, "thinking adaptativo");
    eq(body.output_config, { effort: "low" }, "esforco baixo");
    eq(body.fallbacks, "default", "fallbacks no modo padrao");
    eq(body.max_tokens, 6000, "max_tokens");
    eq(body.cache_control, { type: "ephemeral" }, "cache automatico do fim da conversa");
    for (const k of ["temperature", "top_p", "top_k", "tool_choice", "betas"]) assert(!(k in body), `o corpo nao leva ${k}`);
    assert(body.stream !== true, "sem streaming");
    // prompt de sistema estavel, em bloco com cache; nada que mude a cada chamada
    eq(body.system.length, 1, "um bloco de sistema");
    eq(body.system[0].cache_control, { type: "ephemeral" }, "cache no bloco de sistema");
    eq(body.system[0].text, chat.SYSTEM_PROMPT, "prompt de sistema fixo");
    lacks(body.system[0].text, "2026", "o prompt de sistema nao leva data");
    // ferramentas estritas, so de leitura
    eq(body.tools.map((t: Row) => t.name), ["list_agents", "get_agent", "list_runs", "get_run", "search_events", "list_posts", "get_post", "system_status", "capabilities"], "ferramentas em ordem fixa");
    for (const t of body.tools) {
      eq(t.strict, true, `${t.name} estrita`);
      eq(t.input_schema.type, "object", `${t.name} schema objeto`);
      eq(t.input_schema.additionalProperties, false, `${t.name} sem propriedades extras`);
      eq([...t.input_schema.required].sort(), Object.keys(t.input_schema.properties).sort(), `${t.name}: todas as propriedades obrigatorias`);
      assert(!/(criar|alterar|apagar|update|delete|insert|retry|cancel|publish)/i.test(t.name), `${t.name} nao e de escrita`);
      for (const p of Object.values(t.input_schema.properties) as Row[]) for (const k of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) assert(!(k in p), `${t.name}: sem restricao ${k}`);
    }
    // historico so como texto; a pergunta e a ultima mensagem, com a data fora do prompt de sistema
    eq(body.messages.slice(0, 2), [{ role: "user", content: "Como está a Padaria?" }, { role: "assistant", content: "Sem falhas." }], "historico em texto simples");
    eq(body.messages.length, 3, "historico + pergunta");
    eq(body.messages[2].role, "user", "pergunta por ultimo");
    has(body.messages[2].content, "Pergunta do time: E a Clínica?");
    has(body.messages[2].content, "Agora: 2026-11-15T12:00-03:00");
  });
});

Deno.test("claude: CLAUDE_MODEL troca o modelo", async () => {
  Deno.env.set("CLAUDE_MODEL", "claude-modelo-de-teste");
  try {
    await withFake(() => message([text("ok")], "end_turn"), async (requests) => {
      await chat.claudeChat("teste", [], stubExec().exec, opt);
      eq(requests[0].body.model, "claude-modelo-de-teste", "modelo do ambiente");
    });
  } finally { Deno.env.delete("CLAUDE_MODEL"); }
});

Deno.test("claude: laco em duas etapas, chamadas paralelas respondidas em UMA mensagem de usuario", async () => {
  const first = [THINKING, use("toolu_1", "list_posts", { cliente: "clinica", status: "failed", horas: 168 }), use("toolu_2", "system_status", {})];
  await withFake((_req, n) => (n === 1 ? message(first, "tool_use") : message([text("O post falhou por limite de chamadas.")], "end_turn")), async (requests) => {
    const { exec, calls } = stubExec();
    const out = await chat.claudeChat("Por que o post da Clínica falhou?", [], exec, opt);
    eq(out, { ok: true, text: "O post falhou por limite de chamadas.", iterations: 2 }, "resposta depois das ferramentas");
    eq(requests.length, 2, "duas requisicoes");
    eq(calls, [{ name: "list_posts", input: { cliente: "clinica", status: "failed", horas: 168 } }, { name: "system_status", input: {} }], "as duas ferramentas rodaram com a entrada do modelo");
    const m = requests[1].body.messages;
    eq(m.length, 3, "pergunta, resposta do modelo, resultados");
    eq(m[1], { role: "assistant", content: first }, "conteudo do modelo devolvido inteiro, com o bloco de thinking");
    eq(m[2].role, "user", "resultados em mensagem de usuario");
    eq(m[2].content, [
      { type: "tool_result", tool_use_id: "toolu_1", content: "resultado de list_posts" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "resultado de system_status" },
    ], "os dois resultados na mesma mensagem, na ordem das chamadas");
    eq(requests[1].body.tools, requests[0].body.tools, "ferramentas identicas entre as rodadas (prefixo do cache)");
    eq(requests[1].body.system, requests[0].body.system, "sistema identico entre as rodadas");
  });
});

Deno.test("claude: resultado de ferramenta com erro vai com is_error e o laco continua", async () => {
  const first = [use("toolu_a", "get_post", { post_id: "nao-e-uuid" }), use("toolu_b", "list_agents", { situacao: "todos" })];
  await withFake((_req, n) => (n === 1 ? message(first, "tool_use") : message([text("Não achei o post.")], "end_turn")), async (requests) => {
    const { exec } = stubExec(["get_post"]);
    const out = await chat.claudeChat("Cadê o post?", [], exec, opt);
    assert(out.ok, "o laco termina com resposta");
    eq(requests[1].body.messages[2].content, [
      { type: "tool_result", tool_use_id: "toolu_a", is_error: true, content: "Erro: consulta get_post indisponivel" },
      { type: "tool_result", tool_use_id: "toolu_b", content: "resultado de list_agents" },
    ], "erro marcado com is_error; a outra ferramenta segue normal");
  });
});

Deno.test("claude: limite de 6 rodadas", async () => {
  await withFake((_req, n) => message([use(`toolu_${n}`, "list_agents", { situacao: "todos" })], "tool_use"), async (requests) => {
    const { exec, calls } = stubExec();
    const out = await chat.claudeChat("pergunta sem fim", [], exec, opt);
    eq(out, { ok: false, reason: "max_iterations", detail: null, iterations: 6 }, "para na sexta rodada");
    eq(requests.length, 6, "seis requisicoes, nenhuma a mais");
    eq(calls.length, 5, "na ultima rodada a ferramenta nao roda: nao haveria quem lesse o resultado");
  });
});

Deno.test("claude: prazo esgotado nao chama a API", async () => {
  await withFake(() => message([text("nao deveria chegar")], "end_turn"), async (requests) => {
    const out = await chat.claudeChat("teste", [], stubExec().exec, { ...opt, deadlineMs: 0 });
    eq(out, { ok: false, reason: "deadline", detail: null, iterations: 0 }, "prazo");
    eq(requests.length, 0, "nenhuma requisicao");
  });
});

Deno.test("claude: recusa (stop_reason refusal) nao roda ferramenta", async () => {
  const refusal = message([use("toolu_x", "list_agents", { situacao: "todos" })], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: "teste" } });
  await withFake(() => refusal, async (requests) => {
    const { exec, calls } = stubExec();
    const out = await chat.claudeChat("pergunta", [], exec, opt);
    eq(out, { ok: false, reason: "refusal", detail: "cyber", iterations: 1 }, "recusa");
    eq(calls.length, 0, "nenhuma ferramenta roda em resposta recusada");
    eq(requests.length, 1, "sem nova tentativa");
  });
});

Deno.test("claude: chamada de ferramenta cortada por max_tokens nao roda", async () => {
  await withFake(() => message([use("toolu_x", "get_agent", { cliente: "pad" })], "max_tokens"), async () => {
    const { exec, calls } = stubExec();
    const out = await chat.claudeChat("pergunta", [], exec, opt);
    eq(out, { ok: false, reason: "truncated", detail: null, iterations: 1 }, "cortada");
    eq(calls.length, 0, "entrada cortada nao e executada");
  });
});

// =====================================================================
// Orquestracao: Claude com sucesso, e queda para o modo de regras
// =====================================================================
Deno.test("orquestracao: resposta do Claude com as consultas e os logs; travessao removido", async () => {
  Deno.env.set("ANTHROPIC_API_KEY", KEY);
  try {
    const first = [use("toolu_1", "list_posts", { cliente: "clinica sao lucas", status: "failed", horas: 168 })];
    const final = `O post "Check-up de rotina" falhou ${LONG_DASH} a conta está em pausa.`;
    await withFake((_req, n) => (n === 1 ? message(first, "tool_use") : message([text(final)], "end_turn")), async (requests) => {
      const r = await chat.answerQuestion("Por que o post da Clínica falhou?", [], rulesExec());
      eq(r.mode, "claude", "modo claude");
      eq(r.error, null, "sem erro");
      eq(r.answer, 'O post "Check-up de rotina" falhou, a conta está em pausa.', "travessao trocado por virgula");
      eq(r.tools.length, 1, "uma consulta");
      eq(r.tools[0].name, "list_posts", "nome da consulta");
      eq(r.tools[0].input, { cliente: "clinica sao lucas", status: "failed", horas: 168 }, "entrada da consulta");
      has(r.tools[0].summary, "1 post");
      eq(r.logs.length, 1, "uma linha de log, a do post com falha");
      eq(r.logs[0].client, "Clínica São Lucas", "cliente do log");
      has(r.logs[0].message, "4/2207051");
      // o modelo recebeu o resultado real da ferramenta, sem acento na busca do cliente
      has(requests[1].body.messages[2].content[0].content, "Check-up de rotina");
    });
  } finally { Deno.env.delete("ANTHROPIC_API_KEY"); }
});

Deno.test("orquestracao: 401 do Claude cai no modo de regras, sem nova tentativa", async () => {
  Deno.env.set("ANTHROPIC_API_KEY", KEY);
  try {
    await withFake(() => apiError(401, "authentication_error", "invalid x-api-key"), async (requests) => {
      const r = await chat.answerQuestion("Por que o post da Clínica São Lucas falhou?", [], rulesExec());
      eq(requests.length, 1, "erro de autenticacao nao e repetido");
      eq(r.mode, "regras", "modo de regras");
      assert(r.answer.startsWith("Modo de regras"), "a resposta comeca dizendo que e o modo de regras");
      has(r.answer.split("\n")[0], "401");
      has(r.answer.split("\n")[0], "ANTHROPIC_API_KEY");
      assert((r.error ?? "").startsWith("claude_auth"), `erro registrado: ${r.error}`);
      lacks(r.error ?? "", KEY, "a chave nao aparece no erro");
      has(r.answer, "Check-up de rotina");
      assert(names(r).includes("list_posts"), "as consultas do modo de regras foram feitas");
    });
  } finally { Deno.env.delete("ANTHROPIC_API_KEY"); }
});

Deno.test("orquestracao: modelo inexistente (404) e recusa tambem caem no modo de regras, com o motivo", async () => {
  Deno.env.set("ANTHROPIC_API_KEY", KEY);
  try {
    await withFake(() => apiError(404, "not_found_error", "model: claude-opus-5-5"), async () => {
      const r = await chat.answerQuestion("bom dia", [], rulesExec());
      eq(r.mode, "regras", "404: modo de regras");
      has(r.answer.split("\n")[0], "404");
      assert((r.error ?? "").startsWith("claude_model_or_route"), `erro registrado: ${r.error}`);
    });
    await withFake(() => message([], "refusal", { stop_details: { type: "refusal", category: "general_harms", explanation: "teste" } }), async () => {
      const r = await chat.answerQuestion("bom dia", [], rulesExec());
      eq(r.mode, "regras", "recusa: modo de regras");
      has(r.answer.split("\n")[0], "recusou");
      eq(r.error, "claude_refusal", "erro registrado");
    });
  } finally { Deno.env.delete("ANTHROPIC_API_KEY"); }
});

Deno.test("orquestracao: Claude fora do ar (500) ou inalcancavel tambem cai no modo de regras, dizendo o motivo", async () => {
  Deno.env.set("ANTHROPIC_API_KEY", KEY);
  try {
    await withFake(() => apiError(500, "api_error", "internal server error"), async (requests) => {
      const r = await chat.answerQuestion("bom dia", [], rulesExec());
      eq(requests.length, 2, "o SDK repete uma vez o erro de servidor, e so uma");
      eq(r.mode, "regras", "500: modo de regras");
      has(r.answer.split("\n")[0], "a API do Claude está indisponível agora");
      assert((r.error ?? "").startsWith("claude_server"), `erro registrado: ${r.error}`);
    });
    // porta fechada: falha de rede
    Deno.env.set("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
    const r = await chat.answerQuestion("bom dia", [], rulesExec());
    eq(r.mode, "regras", "rede: modo de regras");
    has(r.answer.split("\n")[0], "não foi possível falar com a API do Claude");
    assert((r.error ?? "").startsWith("claude_network"), `erro registrado: ${r.error}`);
    has(r.answer, "Visão geral: 4 agentes");
  } finally { Deno.env.delete("ANTHROPIC_API_KEY"); Deno.env.delete("ANTHROPIC_BASE_URL"); }
});

Deno.test("orquestracao: limite de rodadas do Claude cai no modo de regras e guarda as consultas dos dois", async () => {
  Deno.env.set("ANTHROPIC_API_KEY", KEY);
  try {
    await withFake((_req, n) => message([use(`toolu_${n}`, "system_status", {})], "tool_use"), async (requests) => {
      const r = await chat.answerQuestion("bom dia", [], rulesExec());
      eq(requests.length, 6, "seis rodadas");
      eq(r.mode, "regras", "modo de regras");
      has(r.answer.split("\n")[0], "o Claude não concluiu a análise em 6 rodadas de consulta");
      eq(r.error, "claude_max_iterations", "erro registrado");
      eq(names(r), ["system_status", "system_status", "system_status", "system_status", "system_status", "list_agents", "system_status"], "cinco consultas do Claude e as duas do modo de regras");
    });
  } finally { Deno.env.delete("ANTHROPIC_API_KEY"); }
});

Deno.test("orquestracao: sem ANTHROPIC_API_KEY nao ha chamada ao Claude", async () => {
  await withFake(() => message([text("nao deveria chegar")], "end_turn"), async (requests) => {
    const r = await chat.answerQuestion("bom dia", [], rulesExec());
    eq(requests.length, 0, "nenhuma requisicao ao Claude");
    eq(r.mode, "regras", "modo de regras");
    eq(r.error, null, "chave ausente e estado de configuracao, nao erro");
    has(r.answer.split("\n")[0], "Modo de regras");
    has(r.answer.split("\n")[0], "ANTHROPIC_API_KEY");
    has(r.answer.split("\n")[0], "não está configurada");
  });
});

// =====================================================================
// Modo de regras: intencoes
// =====================================================================
Deno.test("regras: intencao por palavras-chave, sem acento", () => {
  eq(chat.intentOf("Por que o post da Padaria falhou?"), "falha", "falhou");
  eq(chat.intentOf("o reel NÃO SAIU ontem"), "falha", "nao saiu");
  eq(chat.intentOf("O post não saiu, dá para ver o erro?"), "falha", "falha vence possibilidade");
  eq(chat.intentOf("por que a conta está assim?"), "falha", "por que sem tema");
  eq(chat.intentOf("Qual o status da Padaria?"), "status", "status");
  eq(chat.intentOf("quais os próximos posts"), "status", "proximos");
  eq(chat.intentOf("Pode me dizer como está a fila?"), "status", "pedido educado de status");
  eq(chat.intentOf("Dá para postar story no TikTok?"), "capacidade", "da para");
  eq(chat.intentOf("É possível aprovação automática?"), "capacidade", "e possivel");
  eq(chat.intentOf("Por que não dá para colocar música no Reel?"), "capacidade", "por que + tema");
  eq(chat.intentOf("Tem como agendar 3 posts por dia?"), "capacidade", "tem como");
  eq(chat.intentOf("bom dia"), "geral", "geral");
});

Deno.test("regras: reconhecimento do cliente na pergunta", () => {
  const cs = [{ id: C1, name: "Padaria Aurora", slug: "padaria-aurora" }, { id: C2, name: "Clínica São Lucas", slug: "clinica-sao-lucas" }, { id: C3, name: "Clínica Bella", slug: "clinica-bella" }, { id: C4, name: "Post Café", slug: "post-cafe" }];
  const who = (q: string) => chat.mentionedClients(cs, q).map((c: Row) => c.name);
  eq(who("por que o post da PADARIA AURORA falhou?"), ["Padaria Aurora"], "nome inteiro, sem diferenciar maiuscula");
  eq(who("o que houve com a clinica sao lucas"), ["Clínica São Lucas"], "nome inteiro sem acento");
  eq(who("e a aurora?"), ["Padaria Aurora"], "palavra propria do nome");
  eq(who("status da clinica-bella"), ["Clínica Bella"], "slug");
  eq(who("a clínica não publicou"), ["Clínica São Lucas", "Clínica Bella"], "palavra comum a dois clientes devolve os dois");
  eq(who("por que o post falhou?"), [], "palavra do produto (post) nao escolhe o cliente Post Café");
  eq(who("o post do post café falhou"), ["Post Café"], "nome inteiro vence mesmo com palavra do produto");
  const find = (q: string) => chat.matchClients(cs, q).map((c: Row) => c.name);
  eq(find("CLINICA"), ["Clínica São Lucas", "Clínica Bella"], "busca parcial devolve os candidatos");
  eq(find("lucas clinica"), ["Clínica São Lucas"], "palavras fora de ordem");
  eq(find(C4), ["Post Café"], "id");
  eq(find("mercado"), [], "nao encontrado");
});

Deno.test("regras: falha com cliente citado pelo nome (parcial, sem acento)", async () => {
  const r = await chat.answerQuestion("por que o post da clinica sao lucas falhou?", [], rulesExec());
  eq(r.mode, "regras", "modo");
  assert(r.answer.startsWith("Modo de regras (consultas fixas, sem interpretação livre): a chave do Claude (ANTHROPIC_API_KEY) não está configurada em Configuração, Chaves e integrações."), `primeira linha: ${r.answer.split("\n")[0]}`);
  has(r.answer, "Falhas de Clínica São Lucas nos últimos 7 dias: 1 post e 1 execução.");
  // post com falha, com as tentativas
  has(r.answer, 'Instagram, "Check-up de rotina", agendado para 15/11/2026 06:00, 4 tentativas. Último erro: [4/2207051] (#4) Application request limit reached');
  has(r.answer, "O que o código indica: suspeita de spam ou bloqueio temporário da Meta");
  has(r.answer, "Tentativas:");
  has(r.answer, "15/11/2026 06:00 | publicar | nova tentativa | Instagram, tentativa 1 (início do envio): nova tentativa agendada. [4/2207051]");
  has(r.answer, "15/11/2026 07:00 | publicar | falhou | Instagram, tentativa 4 (início do envio): falha definitiva. [4/2207051]");
  // execucao com falha, com os ultimos eventos
  has(r.answer, "Execuções do agente que falharam:");
  has(r.answer, "etapa publicar, parou em 15/11/2026 07:00");
  has(r.answer, "[publicacao_falhou] Uma ou mais redes recusaram o post.");
  has(r.answer, "15/11/2026 07:00 | publicar | falhou | Instagram: a rede recusou. (#4) Application request limit reached");
  // conta em pausa
  has(r.answer, "Clínica São Lucas: Instagram em pausa até 15/11/2026 14:00");
  // nada de outro cliente
  lacks(r.answer, "Fornada de sábado");
  lacks(r.answer, "Padaria");
  // consultas feitas e registradas
  eq(names(r), ["list_agents", "list_posts", "list_posts", "list_runs", "get_post", "get_run"], "consultas, em ordem");
  eq(r.tools[1].input, { cliente: C2, status: "failed", horas: 168 }, "posts com falha so do cliente citado");
  eq(r.tools[2].input, { cliente: C2, status: "scheduled", horas: 168 }, "fila do cliente citado, para achar post atrasado");
  eq(r.tools[4].input, { post_id: P1 }, "historico do post que falhou");
  eq(r.tools[5].input, { run_id: R3 }, "eventos da execucao que falhou");
  lacks(r.answer, "continuam na fila:", "este cliente nao tem post atrasado");
  assert(r.logs.length >= 5, `linhas de log devolvidas: ${r.logs.length}`);
  assert(r.logs.some((l) => l.step === "publicar" && l.status === "failed" && l.message.includes("tentativa 4")), "log da tentativa definitiva");
  assert(r.logs.every((l) => l.client === "Clínica São Lucas" || l.client === null), "so linhas do cliente citado");
  assert(r.logs.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(l.at)), "datas em ISO");
  lacks(r.answer, LONG_DASH);
});

Deno.test("regras: falha com conta expirada e janela de tempo; palavra propria do nome basta", async () => {
  const r = await chat.answerQuestion("O que deu erro na Aurora?", [], rulesExec());
  has(r.answer, "Falhas de Padaria Aurora nos últimos 7 dias: 1 post e 1 execução.");
  has(r.answer, '"Fornada de sábado"');
  has(r.answer, "[190/460]");
  has(r.answer, "O que o código indica: token inválido, expirado ou revogado");
  has(r.answer, "14/11/2026 12:00 | publicar | reconexão | Instagram, tentativa 1 (início do envio): aguardando reconexão da conta. [190/460]");
  has(r.answer, "[sem_chave_claude] A chave do Claude não está configurada.");
  has(r.answer, "Posts aprovados que passaram do horário e continuam na fila: 1.");
  has(r.answer, '- Instagram, "Café da tarde", agendado para 15/11/2026 10:30. Último erro: [190/460] Reconecte a conta para publicar.');
  assert(r.logs.some((l) => l.status === "atrasado" && l.message.includes("Café da tarde")), "linha de log do post atrasado");
  has(r.answer, "Padaria Aurora: Instagram @padariaaurora com conexão expirada. O cliente precisa reconectar pelo portal");
  has(r.answer, "Padaria Aurora: TikTok não conectado");
  has(r.answer, "O que está pendente para os posts de Padaria Aurora saírem: Reconectar Instagram; Conectar TikTok; Enviar a mídia de 1 post; Cliente aprovar 2 criativos.");
  lacks(r.answer, "Falha antiga fora da janela", "falhas de mais de 7 dias ficam de fora");
  lacks(r.answer, "Check-up de rotina");
  // token que veio dentro da mensagem de erro da rede nao sai
  lacks(JSON.stringify(r), META_TOKEN);
  has(r.answer, "access_token=[oculto]");
});

Deno.test("regras: falha sem cliente citado cobre todas as contas", async () => {
  const r = await chat.answerQuestion("Teve algum erro hoje?", [], rulesExec());
  has(r.answer, "Falhas de todas as contas nas últimas 24 horas: 2 posts e 2 execuções.");
  has(r.answer, 'Clínica São Lucas, Instagram, "Check-up de rotina"');
  has(r.answer, 'Padaria Aurora, Instagram, "Fornada de sábado"');
  has(r.answer, '- Padaria Aurora, Instagram, "Café da tarde", agendado para 15/11/2026 10:30.');
  has(r.answer, "Estúdio Bella: cliente pausado no painel");
  eq(r.tools[1].input, { cliente: "", status: "failed", horas: 24 }, "todas as contas, janela de hoje");
});

Deno.test("regras: nada encontrado e dito com clareza", async () => {
  const r = await chat.answerQuestion("Por que o post da Demo Sorveteria falhou?", [], rulesExec());
  has(r.answer, "Não encontrei post nem execução com falha de Demo Sorveteria nos últimos 7 dias.");
  has(r.answer, "Demo Sorveteria: automação pausada. O agente só roda quando o time manda.");
  eq(names(r), ["list_agents", "list_posts", "list_posts", "list_runs"], "sem falha, nao ha historico para abrir");
});

Deno.test("regras: status de um cliente (agenda, fila, pendencias)", async () => {
  const r = await chat.answerQuestion("Como está a agenda da Padaria Aurora?", [], rulesExec());
  eq(names(r), ["list_agents", "get_agent"], "consultas");
  eq(r.tools[1].input, { cliente: C1 }, "agente do cliente citado");
  has(r.answer, "Cliente Padaria Aurora (slug padaria-aurora");
  has(r.answer, "automação ligada; aprovação pelo cliente; formatos reel, carrossel; redes instagram, tiktok; 7 posts por semana nos horários 12:00, 18:30");
  has(r.answer, "Contas: Instagram @padariaaurora expirada");
  has(r.answer, "TikTok não conectado");
  // 7 posts por semana em 14 horarios: o motor fica com um por dia, as 12:00. O de hoje ja passou (agora = 12:00).
  has(r.answer, "Próximos horários da agenda: 2026-11-16T12:00-03:00, 2026-11-17T18:30-03:00");
  has(r.answer, "(último erro: Error validating access token: Session has expired. access_token=[oculto]); TikTok não conectado");
  has(r.answer, 'Fila de publicação: 2026-11-15T10:30-03:00 Instagram agendado (atrasado) "Café da tarde"; 2026-11-15T15:00-03:00 Instagram agendado "Pão do dia"');
  has(r.answer, "Aprovações pendentes do cliente: 2. Posts com falha em 7 dias: 1.");
  has(r.answer, "aguardando_midia, etapa midia");
  lacks(r.answer, "Clínica");
});

Deno.test("regras: status geral e conta da pergunta anterior", async () => {
  const all = await chat.answerQuestion("Qual o status da fila?", [], rulesExec());
  eq(names(all), ["list_agents", "list_posts", "system_status"], "consultas");
  has(all.answer, "Visão geral: 4 agentes, 2 com a automação ligada. Nos últimos 7 dias: 2 execuções e 2 posts com falha. Aprovações pendentes dos clientes: 3. Execuções em andamento: 1.");
  has(all.answer, "Próximos posts na fila de publicação:");
  has(all.answer, '- 15/11/2026 10:30 | Padaria Aurora | Instagram | "Café da tarde" | atrasado: passou do horário e continua na fila');
  has(all.answer, '- 15/11/2026 15:00 | Padaria Aurora | Instagram | "Pão do dia"\n');
  has(all.answer, "Próximo horário da agenda de cada agente:");
  has(all.answer, "Motor dos agentes: última rodada em 15/11/2026 11:59 (há 1 min).");
  has(all.answer, "Publicador: última rodada em 15/11/2026 11:40 (há 20 min). ALERTA: parado há mais de 5 minutos.");

  const follow = await chat.answerQuestion("e os próximos?", [{ role: "user", text: "Como está a Clínica São Lucas?" }, { role: "assistant", text: "..." }], rulesExec());
  has(follow.answer, "A pergunta não cita uma conta. Considerei a conta da pergunta anterior: Clínica São Lucas.");
  eq(follow.tools[1], { name: "get_agent", input: { cliente: C2 }, summary: "Agente de Clínica São Lucas" }, "agente da conta anterior");
});

Deno.test("regras: possibilidade com tema reconhecido (story no TikTok) e estado atual", async () => {
  const r = await chat.answerQuestion("Dá para postar story no TikTok?", [], rulesExec());
  eq(names(r), ["capabilities", "system_status"], "consultas");
  eq(r.tools[0].input, { temas: ["story", "tiktok"] }, "temas pedidos");
  has(r.answer, "No TikTok a opção fica travada: não há story pela API.");
  has(r.answer, "O TikTok é publicado pelo provedor Upload-Post.");
  has(r.answer, "A VERIFICAR");
  has(r.answer, "Estado atual: TikTok: provedor não configurado (falta o segredo UPLOAD_POST_API_KEY).");
  has(r.answer, "Uma análise do caso específico precisa do Claude funcionando (segredo ANTHROPIC_API_KEY).");
  eq(r.logs, [], "pergunta de possibilidade nao devolve linhas de log");
});

Deno.test("regras: possibilidade para cada tema pedido no enunciado", async () => {
  const cases: [string, string, string][] = [
    ["Dá para colocar música no Reel?", "musica", "A API de publicação não escolhe música da biblioteca"],
    ["É possível publicar sem legenda?", "legenda", "O cliente pode desligar a legenda antes de aprovar"],
    ["Consegue marcar a localização?", "localizacao", "ID numérico da Página do Facebook do local"],
    ["Pode ter link clicável?", "link", "não deixam clicar em link de legenda"],
    ["Tem como fazer carrossel com vídeo?", "carrossel", "No Instagram pode misturar imagens e vídeos"],
    ["Dá para mudar o horário?", "ritmo", "espalhados entre até 6 horários"],
    ["Dá para aumentar a frequência?", "ritmo", "de 1 a 28 posts por semana"],
    ["É possível aprovação automática?", "aprovacao", '"automatica": o agente aprova sozinho'],
    ["Dá para gerar imagem sozinho?", "midia", '"manual" (padrão): o time envia a mídia pelo painel'],
    ["O agente consegue gerar vídeo?", "midia", "A VERIFICAR"],
    ["Dá para publicar no Facebook?", "limites", "publicar em outras redes além de Instagram e TikTok"],
  ];
  for (const [question, topic, expected] of cases) {
    const r = await chat.answerQuestion(question, [], rulesExec());
    assert((r.tools[0].input.temas as string[]).includes(topic), `"${question}" deveria consultar o tema ${topic}, consultou ${JSON.stringify(r.tools[0].input)}`);
    has(r.answer, expected);
  }
});

Deno.test("regras: possibilidade sem tema reconhecido diz que precisa da chave do Claude", async () => {
  const r = await chat.answerQuestion("Dá para exportar um relatório em PDF?", [], rulesExec());
  eq(names(r), ["capabilities"], "so o indice de temas");
  eq(r.tools[0].input, { temas: [] }, "indice");
  has(r.answer, "Não reconheci o assunto desta pergunta");
  has(r.answer, "Uma resposta livre precisa do Claude funcionando, com a chave no segredo ANTHROPIC_API_KEY da função");
  has(r.answer, "- story: Story");
  has(r.answer, "- tiktok: TikTok");
  lacks(r.answer, "Visão geral");
});

Deno.test("regras: qualquer outra coisa vira a saude geral dos agentes", async () => {
  const r = await chat.answerQuestion("bom dia", [], rulesExec());
  eq(names(r), ["list_agents", "system_status"], "consultas");
  has(r.answer, "Segue a saúde geral dos agentes.");
  has(r.answer, "Visão geral: 4 agentes, 2 com a automação ligada.");
  has(r.answer, "Agentes que pedem atenção:");
  has(r.answer, "- Padaria Aurora: 1 execução e 1 post com falha em 7 dias; pendências: Reconectar Instagram, Conectar TikTok, Enviar a mídia de 1 post, Cliente aprovar 2 criativos.");
  has(r.answer, "- Clínica São Lucas: 1 execução e 1 post com falha em 7 dias; pendências: Cliente aprovar 1 criativo; conta em pausa pedida pela rede.");
  has(r.answer, "Publicador: última rodada em 15/11/2026 11:40 (há 20 min). ALERTA: parado há mais de 5 minutos.");
});

Deno.test("regras: sem intencao reconhecida, mas com conta citada, mostra a situacao da conta", async () => {
  const r = await chat.answerQuestion("O que o agente da Padaria Aurora fez?", [], rulesExec());
  eq(names(r), ["list_agents", "get_agent"], "consultas");
  has(r.answer, "Segue a situação de Padaria Aurora.");
  has(r.answer, "Cliente Padaria Aurora (slug padaria-aurora");
  has(r.answer, "Últimas execuções:");
  lacks(r.answer, "Visão geral");
  assert(r.logs.length > 0 && r.logs.every((l) => l.client === "Padaria Aurora" || l.client === null), "so linhas da conta citada");
});

// =====================================================================
// Ferramentas: leitura, limites e segredos
// =====================================================================
const ALL_CALLS: [string, Row][] = [
  ["list_agents", { situacao: "todos" }], ["list_agents", { situacao: "com_erro" }], ["list_agents", { situacao: "pausados" }], ["list_agents", { situacao: "com_pendencia" }],
  ["get_agent", { cliente: "padaria" }], ["get_agent", { cliente: "CLINICA SAO" }], ["get_agent", { cliente: C4 }], ["get_agent", { cliente: "estudio-bella" }], ["get_agent", { cliente: "nao existe" }],
  ["list_runs", { cliente: "", status: "todos", horas: 720 }], ["list_runs", { cliente: "aurora", status: "falhou", horas: 168 }], ["list_runs", { cliente: "", status: "ativas", horas: 1 }],
  ["get_run", { run_id: R1 }], ["get_run", { run_id: R2 }], ["get_run", { run_id: R3 }], ["get_run", { run_id: "00000000-0000-4000-8000-000000000000" }],
  ["search_events", { texto: "", cliente: "", status: "todos", horas: 720 }], ["search_events", { texto: "midia", cliente: "", status: "todos", horas: 168 }], ["search_events", { texto: "graph", cliente: "clinica", status: "info", horas: 24 }],
  ["list_posts", { cliente: "", status: "todos", horas: 720 }], ["list_posts", { cliente: "", status: "failed", horas: 168 }], ["list_posts", { cliente: "padaria", status: "scheduled", horas: 1 }],
  ["get_post", { post_id: P1 }], ["get_post", { post_id: P3 }], ["get_post", { post_id: P4 }], ["get_post", { post_id: "00000000-0000-4000-8000-000000000000" }],
  ["system_status", {}],
  ["capabilities", { temas: [] }], ["capabilities", { temas: chat.TOPIC_KEYS.slice(0, 5) }], ["capabilities", { temas: chat.TOPIC_KEYS.slice(5, 10) }], ["capabilities", { temas: chat.TOPIC_KEYS.slice(10) }],
];

Deno.test("ferramentas: nenhum campo com cara de segredo sai, em nenhuma consulta", async () => {
  const { d, asked } = fakeData(NOW);
  const exec = chat.makeExec(d, () => NOW);
  for (const [name, input] of ALL_CALLS) {
    const out = await exec(name, input);
    const dump = JSON.stringify(out);
    for (const mark of SECRET_MARKS) lacks(dump, mark, `${name} ${JSON.stringify(input)} deixou passar "${mark.slice(0, 12)}..."`);
    for (const field of ["token_secret_id", "provider_ref", "external_id", "fb_user_id", "worker_secret", "key_hash", "token_hash", "container_id", "media_job"]) lacks(dump, field, `${name} citou o campo ${field}`);
    assert(out.text.length > 0 && out.summary.length > 0, `${name} devolve texto e resumo`);
  }
  // settings: so chaves da lista permitida sao pedidas, e o que veio a mais nao e lido
  assert(asked.length > 0, "system_status leu settings");
  for (const k of asked) assert(chat.SETTINGS_OK.includes(k), `chave de settings fora da lista: ${k}`);
  assert(!chat.SETTINGS_OK.includes("worker_secret"), "worker_secret fora da lista");
  // a mensagem de erro com token e chave continua util, mas sem o segredo
  const ev = await exec("search_events", { texto: "graph", cliente: "", status: "todos", horas: 24 });
  has(ev.text, "access_token=[oculto]");
  has(ev.text, "srp_adm_[oculto]");
  has(ev.text, "o hash [oculto]");
  has(ev.logs[0].message, "access_token=[oculto]");
});

Deno.test("datas: ISO no fuso de Sao Paulo, formato brasileiro e texto do Postgres", () => {
  eq(chat.isoSP("2026-11-15T15:00:00.000Z"), "2026-11-15T12:00-03:00", "UTC para Sao Paulo");
  eq(chat.isoSP("2026-01-01T01:30:00+00:00"), "2025-12-31T22:30-03:00", "virada de ano");
  eq(chat.isoSP("2026-11-15 15:00:00.123456+00"), "2026-11-15T12:00-03:00", "data em texto do Postgres (trava)");
  eq(chat.brSP("2026-11-15T15:00:00.000Z"), "15/11/2026 12:00", "formato brasileiro");
  eq([chat.isoSP(null), chat.isoSP("nao e data"), chat.brSP(undefined)], ["sem data", "sem data", "sem data"], "sem data");
});

Deno.test("ferramentas: filtro de segredos preserva o que e util", () => {
  // Valores de mentira, montados em tempo de execucao: o arquivo nao guarda nada com formato de credencial.
  const jwt = ["eyJ" + "0ZXN0ZSI6InRlc3RlIn0", "eyJ" + "zdWIiOiJ0ZXN0ZSJ9", "assinatura_de_teste_0001"].join(".");
  const link = "https://exemplo.com.br/portal/#" + "Ab3dE_gh-".repeat(5);
  const antKey = "sk-" + "ant-teste-abcDEF123", cliKey = "srp_" + "cli_abc123DEF";
  const out = chat.scrub(`jwt ${jwt} link ${link} Bearer abcdef123456789 ${antKey} ${cliKey} token=abc123 run ${R1} erro [190/460] (#4) code=190`);
  for (const gone of [jwt, "Ab3dE_gh-Ab3dE", "abcdef123456789", antKey, cliKey, "token=abc123"]) lacks(out, gone);
  for (const kept of [R1, "[190/460]", "(#4)", "code=190", "https://exemplo.com.br/portal/#[oculto]"]) has(out, kept);
});

Deno.test("ferramentas: conteudo e busca (acento, nome parcial, id, nao encontrado)", async () => {
  const { d } = fakeData(NOW);
  const exec = chat.makeExec(d, () => NOW);
  // busca de evento sem acento encontra mensagem com acento
  const midia = await exec("search_events", { texto: "midia", cliente: "", status: "todos", horas: 168 });
  has(midia.text, "Aguardando o time enviar a mídia deste post.");
  eq(midia.data?.events, 1, "um evento com midia");
  // execucao com todos os eventos, em ordem, e so as chaves permitidas do detalhe
  const run = await exec("get_run", { run_id: R1 });
  has(run.text, `Execução ${R1} de Padaria Aurora: status falhou, etapa copy`);
  has(run.text, "Erro [sem_chave_claude] A chave do Claude não está configurada. Leitura do código: erro de configuração do fornecedor");
  has(run.text, "Eventos (5, do mais antigo para o mais recente):");
  assert(run.text.indexOf("Escolhendo o tema do post.") < run.text.indexOf("| copy | falhou |"), "eventos em ordem cronologica");
  has(run.text, "(codigo=sem_chave_claude, tentativa=1, definitivo=true)");
  eq(run.logs.length, 5, "cinco linhas de log");
  // post com historico de tentativas e situacao da conta
  const post = await exec("get_post", { post_id: P1 });
  has(post.text, `Post ${P1} de Clínica São Lucas: Instagram, "Check-up de rotina" (feed, image), status falhou.`);
  has(post.text, "Histórico de tentativas (4, da mais antiga para a mais recente):");
  has(post.text, "2026-11-15T07:00-03:00 | tentativa 4, início do envio | falha definitiva | [4/2207051] (#4) Application request limit reached | suspeita de spam (Meta)");
  has(post.text, "Conta do cliente nesta rede: Instagram @clinicasaolucas conectada, em pausa até 2026-11-15T14:00-03:00.");
  // posts: filtro, datas ISO no fuso de Sao Paulo e erro com codigo
  const posts = await exec("list_posts", { cliente: "", status: "failed", horas: 168 });
  has(posts.text, "Posts de todas as contas (status falhou, agendados nos últimos 7 dias ou depois): 2.");
  has(posts.text, `agendado para 2026-11-15T06:00-03:00 | Clínica São Lucas | Instagram | falhou | "Check-up de rotina" | tentativas 4 | último erro [4/2207051] (#4) Application request limit reached | id ${P1}`);
  const queue = await exec("list_posts", { cliente: "aurora", status: "scheduled", horas: 24 });
  has(queue.text, `- agendado para 2026-11-15T10:30-03:00 | Padaria Aurora | Instagram | agendado (atrasado: passou do horário e continua na fila) | "Café da tarde" | tentativas 0 | último erro [190/460] Reconecte a conta para publicar. | id ${P6}`);
  has(queue.text, `- agendado para 2026-11-15T15:00-03:00 | Padaria Aurora | Instagram | agendado | "Pão do dia" | tentativas 0 | id ${P2}`);
  has((await exec("get_post", { post_id: P6 })).text, "atrasado: passou do horário e continua na fila; tentativas 0.");
  // cliente por nome parcial sem acento, por slug e por id; e nao encontrado
  for (const q of ["clinica", "SÃO LUCAS", "clinica-sao-lucas", C2]) has((await exec("get_agent", { cliente: q })).text, "Cliente Clínica São Lucas");
  const none = await exec("get_agent", { cliente: "mercado" });
  has(none.text, 'Nenhum cliente encontrado com "mercado". Clientes cadastrados: Padaria Aurora; Clínica São Lucas; Estúdio Bella; Demo Sorveteria.');
  has((await exec("list_runs", { cliente: "mercado", status: "todos", horas: 24 })).text, "Nenhum cliente encontrado");
  has((await exec("get_run", { run_id: "00000000-0000-4000-8000-000000000000" })).text, "não encontrada");
  // estado do sistema
  const sys = await exec("system_status", {});
  has(sys.text, "Motor dos agentes (agendador /agents/tick, a cada minuto): última rodada em 2026-11-15T11:59-03:00 (há 1 min)");
  has(sys.text, "ALERTA: o publicador não roda há mais de 5 minutos.");
  lacks(sys.text, "ALERTA: o motor dos agentes");
  has(sys.text, "Ritmo de publicação por conta: intervalo mínimo de 15 minutos, teto de 12 publicações em 24 horas");
  has(sys.text, "Claude não configurado (falta o segredo ANTHROPIC_API_KEY na função)");
  has(sys.text, "TikTok (provedor Upload-Post) não configurado (falta o segredo UPLOAD_POST_API_KEY)");
  has(sys.text, "Execuções em andamento: 1 (rodando 0, aguardando mídia 1, aguardando aprovação 0, publicando 0).");
  has(sys.text, "Contas conectadas: 2; expiradas ou revogadas: 1; em pausa pedida pela rede: 1. Clientes: 4, pausados: 1.");
  has(sys.text, "criou 1 execução, avançou 2 etapas, registrou 0 mudanças de aprovação ou publicação, deixou 0 para a rodada seguinte. Erros da rodada: copy aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1: A chave do Claude não está configurada.");
  lacks(sys.text, "..", "sem ponto duplicado");
  // agentes com filtro
  const bad = await exec("list_agents", { situacao: "com_erro" });
  has(bad.text, "Agentes (filtro com_erro): 3 de 4.");
  has(bad.text, "- Padaria Aurora | agente ativo, automação ligada, aprovação cliente | contas: Instagram @padariaaurora expirada; TikTok não conectado | 7 dias: 1 execução e 1 post com falha | aprovações pendentes: 2 | em andamento: 1 (1 esperando mídia do time)");
  has(bad.text, "- Estúdio Bella | cliente pausado");
  lacks(bad.text, "Demo Sorveteria");
});

Deno.test("ferramentas: a lista de clientes e lida uma vez por pergunta", async () => {
  const { d } = fakeData(NOW);
  let reads = 0;
  const exec = chat.makeExec({ ...d, clients: () => { reads++; return d.clients(); } }, () => NOW);
  const r = await chat.answerQuestion("por que o post da clinica sao lucas falhou?", [], exec);
  eq(r.tools.length, 6, "seis consultas");
  eq(reads, 1, "uma leitura de clientes para as seis consultas");
});

Deno.test("ferramentas: entrada invalida vira erro para o modelo corrigir; ferramenta desconhecida tambem", async () => {
  const exec = rulesExec();
  const fails = async (name: string, input: Row, part: string) => {
    let msg = "";
    try { await exec(name, input); } catch (e) { msg = (e as Error).message; }
    has(msg, part, `${name} deveria falhar com "${part}", veio "${msg}"`);
  };
  await fails("get_run", { run_id: "abc" }, "run_id deve ser o id completo");
  await fails("get_post", { post_id: "" }, "post_id deve ser o id completo");
  await fails("get_agent", { cliente: "" }, "Informe o nome");
  await fails("apagar_tudo", {}, "Ferramenta desconhecida");
});

Deno.test("ferramentas: saida abaixo de 6.000 caracteres com muito dado", async () => {
  const fx = fixture(NOW);
  const base = fx.clients[1];
  for (let i = 0; i < 150; i++) {
    const id = crypto.randomUUID();
    // metade sem nenhum problema (conta conectada, sem pausa, sem falha): entra so pelo nome na lista resumida
    if (i % 2) { fx.clients.push({ ...base, id, name: `Conta tranquila ${i}`, slug: `conta-tranquila-${i}`, social_accounts: [{ ...base.social_accounts[0], cooldown_until: null }] }); continue; }
    fx.clients.push({ ...base, id, name: `Cliente de volume número ${i} com nome comprido`, slug: `cliente-volume-${i}` });
    fx.runs.push({ ...fx.runs[0], id: crypto.randomUUID(), client_id: id, error: "Falha longa de teste. ".repeat(20) });
    fx.posts.push({ ...fx.posts[0], id: crypto.randomUUID(), client_id: id, last_error: "Erro longo devolvido pela rede. ".repeat(20) });
    for (let k = 0; k < 4; k++) fx.events.push({ ...fx.events[4], id: 1000 + i * 4 + k, client_id: id, run_id: R1, message: "Mensagem longa de evento de teste. ".repeat(12) });
    fx.attempts.push({ ...fx.attempts[0], post_id: P1, error: "Tentativa com erro comprido. ".repeat(15) });
  }
  const exec = chat.makeExec(fakeData(NOW, fx).d, () => NOW);
  for (const [name, input] of [...ALL_CALLS, ["get_agent", { cliente: "volume número 1" }], ["get_agent", { cliente: "cliente de volume" }]] as [string, Row][]) {
    const out = await exec(name, input);
    assert(out.text.length <= 6000, `${name} ${JSON.stringify(input)} devolveu ${out.text.length} caracteres`);
    assert(out.logs.length <= 400, `${name}: linhas de log demais (${out.logs.length})`);
  }
  const many = (await exec("list_agents", { situacao: "todos" })).text;
  has(many, "Lista resumida por causa do tamanho");
  has(many, "omitidas pelo limite de tamanho");
  assert(many.split("\n").filter((l) => l.startsWith("- ")).length >= 25, "a lista resumida mostra os agentes com problema, um por linha");
  // 75 contas tranquilas do volume mais a Demo Sorveteria
  has(many, "Sem falha em 7 dias, sem conta com problema e sem pendência (76): Conta tranquila 1; Conta tranquila 101;");
  has((await exec("get_run", { run_id: R1 })).text, "eventos mais antigos omitidos pelo limite de tamanho");
  // a resposta do chat limita as linhas de log devolvidas
  const r = await chat.answerQuestion("Teve algum erro?", [], exec);
  assert(r.logs.length <= 40, `no maximo 40 linhas de log na resposta, vieram ${r.logs.length}`);
});

Deno.test("texto: sem travessao no prompt, na referencia, nas descricoes e nas respostas do modo de regras", async () => {
  const exec = rulesExec();
  const texts = [chat.SYSTEM_PROMPT, JSON.stringify(chat.DIAG_TOOLS)];
  for (const [name, input] of ALL_CALLS) texts.push((await exec(name, input)).text);
  for (const q of ["Por que o post da Padaria Aurora falhou?", "status da Clínica São Lucas", "Dá para postar story no TikTok?", "Dá para exportar em PDF?", "oi"]) texts.push((await chat.answerQuestion(q, [], exec)).answer);
  for (const t of texts) {
    lacks(t, LONG_DASH, "travessao encontrado");
    assert(!/ -{2} /.test(t), "dois hifens como pontuacao");
  }
  // o prompt cobre o que o pedido exige
  for (const part of ["somente leitura", "Nunca revele segredos", "America/Sao_Paulo", "Nunca use travessão", "capabilities", "Português do Brasil"]) has(chat.SYSTEM_PROMPT, part);
});

// =====================================================================
// Rotas
// =====================================================================
function fakeStore(failSave = false) {
  const saved: Row[] = [], limits: number[] = [];
  const store: ChatStore = {
    save: (row) => { if (failSave) return Promise.reject(new Error("banco fora")); saved.push(row); return Promise.resolve(saved.length + 40); },
    history: (limit) => { limits.push(limit); return Promise.resolve([{ id: 2, question: "p2", answer: "r2", mode: "regras", created_at: "2026-11-15T12:00:00Z", tools: [], error: null }, { id: 1, question: "p1", answer: "r1", mode: "claude", created_at: "2026-11-15T11:00:00Z", tools: [], error: null }].slice(0, limit)); },
  };
  return { store, saved, limits };
}
const post = (body: unknown) => new Request("http://local/admin/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

Deno.test("rotas: POST /admin/chat responde no formato do contrato e grava em diag_chats", async () => {
  const realNow = new Date();
  const { store, saved } = fakeStore();
  chat.deps.data = fakeData(realNow).d; chat.deps.store = store;
  const res = await chat.chatRoutes(post({ question: "  Por que o post da Clínica São Lucas falhou?  ", history: [{ role: "assistant", text: "resposta solta" }, { role: "user", text: "oi" }, { role: "sistema", text: "ignorar" }] }), ["chat"]);
  assert(res, "rota atendida");
  eq(res.status, 200, "status 200");
  const body = await res.json();
  eq(Object.keys(body).sort(), ["answer", "duration_ms", "id", "logs", "mode", "tools"], "campos do contrato");
  eq(body.id, 41, "id do registro gravado");
  eq(body.mode, "regras", "modo");
  assert(typeof body.answer === "string" && body.answer.startsWith("Modo de regras"), "resposta");
  assert(Number.isInteger(body.duration_ms) && body.duration_ms >= 0, "duracao");
  for (const t of body.tools) eq(Object.keys(t).sort(), ["input", "name", "summary"], "formato de cada consulta");
  for (const l of body.logs) eq(Object.keys(l).sort(), ["at", "client", "message", "status", "step"], "formato de cada linha de log");
  has(body.answer, "Check-up de rotina");
  eq(saved.length, 1, "uma gravacao");
  eq(Object.keys(saved[0]).sort(), ["answer", "duration_ms", "error", "mode", "question", "tools"], "colunas gravadas");
  eq(saved[0].question, "Por que o post da Clínica São Lucas falhou?", "pergunta gravada sem espacos nas pontas");
  eq(saved[0].answer, body.answer, "resposta gravada");
  eq(saved[0].mode, "regras", "modo gravado");
  eq(saved[0].tools, body.tools, "consultas gravadas");
  eq(saved[0].error, null, "sem erro");
});

Deno.test("rotas: pergunta vazia e 400; falha ao gravar o historico nao derruba a resposta", async () => {
  const { store, saved } = fakeStore();
  chat.deps.data = fakeData(new Date()).d; chat.deps.store = store;
  for (const bad of [{}, { question: "" }, { question: "  a " }, { question: 123 }]) {
    let err: unknown = null;
    try { await chat.chatRoutes(post(bad), ["chat"]); } catch (e) { err = e; }
    assert(err instanceof core.HttpError, "erro HTTP");
    eq([err.status, err.code, err.message], [400, "question_required", "Escreva a pergunta."], "pergunta obrigatoria");
  }
  eq(saved.length, 0, "nada gravado para pergunta invalida");
  chat.deps.store = fakeStore(true).store;
  const res = await chat.chatRoutes(post({ question: "bom dia" }), ["chat"]);
  const body = await res!.json();
  eq([res!.status, body.id, body.mode], [200, 0, "regras"], "responde mesmo sem gravar; id 0 indica que nao gravou");
});

Deno.test("rotas: falha ao consultar os dados vira 500 com mensagem clara e fica registrada", async () => {
  const { store, saved } = fakeStore();
  const { d } = fakeData(new Date());
  chat.deps.data = { ...d, clients: () => Promise.reject(new Error(`conexao recusada token=${"z".repeat(30)}`)) }; chat.deps.store = store;
  let err: unknown = null;
  try { await chat.chatRoutes(post({ question: "bom dia" }), ["chat"]); } catch (e) { err = e; }
  assert(err instanceof core.HttpError, "erro HTTP");
  eq([err.status, err.code, err.message], [500, "chat_failed", "Não foi possível consultar os dados para responder a esta pergunta. Tente de novo em instantes."], "erro do chat, com mensagem para o time");
  eq(saved.length, 1, "a pergunta fica registrada mesmo com falha");
  eq([saved[0].question, saved[0].answer, saved[0].mode, saved[0].tools], ["bom dia", "Não foi possível consultar os dados para responder a esta pergunta.", "regras", []], "registro da pergunta sem resposta");
  has(saved[0].error, "conexao recusada");
  lacks(saved[0].error, "zzzzzzzz", "segredo fora do erro gravado");
});

Deno.test("rotas: GET /admin/chat/history e rotas desconhecidas", async () => {
  const { store, limits } = fakeStore();
  chat.deps.store = store;
  const res = await chat.chatRoutes(new Request("http://local/admin/chat/history?limit=1"), ["chat", "history"]);
  eq(await res!.json(), { items: [{ id: 2, question: "p2", answer: "r2", mode: "regras", created_at: "2026-11-15T12:00:00Z" }] }, "itens no formato do contrato, sem campos internos");
  await chat.chatRoutes(new Request("http://local/admin/chat/history"), ["chat", "history"]);
  await chat.chatRoutes(new Request("http://local/admin/chat/history?limit=9999"), ["chat", "history"]);
  await chat.chatRoutes(new Request("http://local/admin/chat/history?limit=abc"), ["chat", "history"]);
  eq(limits, [1, 30, 100, 30], "limite padrao 30 e teto 100");
  eq(await chat.chatRoutes(new Request("http://local/admin/chat/outra"), ["chat", "outra"]), null, "rota desconhecida");
  eq(await chat.chatRoutes(new Request("http://local/admin/chat"), ["chat"]), null, "GET em /admin/chat");
  eq(await chat.chatRoutes(new Request("http://local/admin/chat/history", { method: "POST" }), ["chat", "history"]), null, "POST em history");
  eq(await chat.chatRoutes(new Request("http://local/admin/agents"), ["agents"]), null, "outro prefixo");
});
