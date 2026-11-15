// Testes dos geradores. Nada aqui fala com o Claude nem com o Higgsfield de verdade: os dois sao servidores falsos
// locais (127.0.0.1) que conferem o formato do pedido e devolvem respostas no formato documentado.
// Rodar, a partir de supabase/functions/api:
//   deno test --allow-net=127.0.0.1 --allow-env --allow-read tests/generators_test.ts
// lib/core.ts cria o cliente do Supabase na importacao: as variaveis abaixo precisam existir antes do import dinamico.
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:9");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const G = await import("../lib/generators.ts");
const { GenConfigError } = await import("../lib/gentypes.ts");
type AgentProfile = import("../lib/gentypes.ts").AgentProfile;
type GenContext = import("../lib/gentypes.ts").GenContext;
type MediaRequest = import("../lib/gentypes.ts").MediaRequest;
type Copy = import("../lib/gentypes.ts").Copy;

// deno-lint-ignore no-explicit-any
type Any = any;
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const EM = cp(0x2014), EN = cp(0x2013), ZWSP = cp(0x200b), ZWJ = cp(0x200d), NBSP = cp(0xa0), LQ = cp(0x201c), RQ = cp(0x201d);
const DOUBLE = " " + "-".repeat(2) + " "; // dois hifens entre espacos, usados como travessao

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(`Falhou: ${msg}`); }
function eq(a: unknown, b: unknown, msg: string) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`Falhou: ${msg}\n  obtido:   ${x}\n  esperado: ${y}`);
}
async function rejects(fn: () => Promise<unknown>, msg: string): Promise<Error> {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error(`Falhou: ${msg} (era para dar erro)`);
}
function throwsSync(fn: () => unknown, msg: string): Error {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error(`Falhou: ${msg} (era para dar erro)`);
}

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  client_id: "11111111-1111-4111-8111-111111111111", client_name: "Clínica Aurora", segment: "Estética", timezone: "America/Sao_Paulo", is_demo: false,
  agent_name: "Aurora", context: "Clínica de estética em Moema, São Paulo. Atende há 12 anos.", audience: "mulheres de 30 a 50 anos", tone: "direto e acolhedor",
  pillars: ["Cuidados com a pele", "Bastidores"], formats: ["reel", "carrossel", "imagem", "story"], platforms: ["instagram", "tiktok"],
  voice: { usa: "pele, rotina", evita: "barato, milagre", cta: "Comente AGENDA para receber os horários.", provas: "87% das clientes voltam em 6 meses", proibido: "antes e depois" },
  default_link: "https://aurora.example/agenda", ai_label: true, story_default: false, ...over,
});
const context = (over: Partial<GenContext> = {}): GenContext => ({
  slot_at: "2026-11-17T15:33:00.000Z", formato: "reel", pilar: "Cuidados com a pele", recentes: ["Protetor solar no inverno"], feedback: null, revision: 0, ...over,
});
const PLAN = { tema: "O erro de lavar o rosto com água quente", pilar: "Cuidados com a pele", objetivo: "salvamento", angulo: "Explicar o que a água quente faz com a pele." };

// ---------- Servidor falso ----------
type Hit = { method: string; path: string; headers: Headers; body: Any };
async function withServer(handler: (hit: Hit, base: string) => Response | Promise<Response>, run: (base: string, hits: Hit[]) => Promise<void>) {
  const hits: Hit[] = [];
  let base = "";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const raw = await req.text();
    let body: Any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = raw; }
    const hit = { method: req.method, path: url.pathname + url.search, headers: req.headers, body };
    hits.push(hit);
    return handler(hit, base);
  });
  base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  try { await run(base, hits); } finally { await server.shutdown(); }
}
const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// =====================================================================================
// Claude (servidor falso da Messages API)
// =====================================================================================
const claudeMessage = (value: unknown, over: Record<string, unknown> = {}) => jsonRes({
  id: "msg_teste", type: "message", role: "assistant", model: "claude-opus-5-5",
  // A resposta real pode abrir com um bloco de raciocinio vazio: o gerador tem de ler por tipo de bloco.
  content: [{ type: "thinking", thinking: "", signature: "assinatura" }, { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  stop_reason: "end_turn", stop_sequence: null, stop_details: null,
  usage: { input_tokens: 120, output_tokens: 340, cache_creation_input_tokens: 0, cache_read_input_tokens: 2100 },
  ...over,
});
const claudeError = (status: number, type: string, message: string) => jsonRes({ type: "error", error: { type, message } }, status);

async function withClaude(handler: (hit: Hit) => Response, run: (hits: Hit[]) => Promise<void>) {
  await withServer(handler, async (base, hits) => {
    Deno.env.set("ANTHROPIC_BASE_URL", base);
    Deno.env.set("ANTHROPIC_API_KEY", "chave-de-teste");
    try { await run(hits); } finally { Deno.env.delete("ANTHROPIC_BASE_URL"); Deno.env.delete("ANTHROPIC_API_KEY"); }
  });
}
const claude = () => G.textGeneratorFor({ text_provider: "claude" }, profile());

Deno.test("claude: formato do pedido, leitura do plano e uso de tokens", async () => {
  await withClaude(() => claudeMessage({ tema: `Água quente no rosto ${EM} o erro de todo dia`, pilar: "Cuidados com a pele", objetivo: "salvamento", angulo: "Mostrar o efeito." }), async (hits) => {
    const p = profile(), r = await claude().plan(p, context());
    eq(hits.length, 1, "uma chamada so, sem nova tentativa do SDK");
    const h = hits[0], b = h.body;
    eq(h.method, "POST", "metodo");
    assert(h.path.startsWith("/v1/messages"), `caminho da Messages API: ${h.path}`);
    // O SDK escolhe o cabecalho da chave (x-api-key ou Authorization: Bearer) pelo formato dela: vale qualquer um dos dois.
    assert(h.headers.get("x-api-key") === "chave-de-teste" || h.headers.get("authorization") === "Bearer chave-de-teste", "chave enviada no cabecalho");
    assert((h.headers.get("anthropic-beta") ?? "").includes("server-side-fallback-2026-07-01"), "beta do fallback no cabecalho");
    eq(b.model, "claude-opus-5-5", "modelo");
    eq(b.thinking, { type: "adaptive" }, "thinking adaptativo");
    eq(b.output_config.effort, "medium", "esforco medio");
    eq(b.output_config.format.type, "json_schema", "saida estruturada");
    const schema = b.output_config.format.schema;
    eq(schema.additionalProperties, false, "esquema fechado");
    eq(schema.required, ["tema", "pilar", "objetivo", "angulo"], "campos obrigatorios do plano");
    eq(b.fallbacks, "default", "fallbacks no modo default");
    for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "tools", "betas"]) assert(!(banned in b), `o corpo nao leva ${banned}`);
    assert(!b.stream, "sem streaming");
    assert(typeof b.max_tokens === "number" && b.max_tokens >= 4000, "max_tokens com folga para o raciocinio");
    // Prompt de sistema fixo e marcado para cache; os dados do cliente ficam na mensagem.
    eq(b.system.length, 1, "um bloco de sistema");
    eq(b.system[0].cache_control, { type: "ephemeral" }, "bloco de sistema marcado para cache");
    const system: string = b.system[0].text;
    assert(!system.includes(p.client_name) && !system.includes("2026"), "sistema sem nome de cliente e sem data");
    assert(system.includes("Nunca invente número") && system.includes("travessão") && system.includes("Confissão de Custo"), "regras do pacote no sistema");
    eq(b.messages.length, 1, "uma mensagem");
    const user: string = b.messages[0].content;
    for (const piece of [p.client_name, "Atende há 12 anos", "87% das clientes voltam", "Palavras que evita: barato, milagre", "Pilar sugerido: Cuidados com a pele", "Protetor solar no inverno", "TAREFA: PLANO", "reel"]) {
      assert(user.includes(piece), `mensagem traz "${piece}"`);
    }
    eq(r.value, { tema: "Água quente no rosto, o erro de todo dia", pilar: "Cuidados com a pele", objetivo: "salvamento", angulo: "Mostrar o efeito." }, "plano lido, com o travessao trocado");
    eq(r.usage, { provider: "claude", model: "claude-opus-5-5", input_tokens: 2220, output_tokens: 340 }, "uso de tokens (entrada soma o cache)");
  });
});

Deno.test("claude: modelo trocado por CLAUDE_MODEL", async () => {
  Deno.env.set("CLAUDE_MODEL", "claude-modelo-de-teste");
  try {
    await withClaude(() => claudeMessage(PLAN), async (hits) => {
      await claude().plan(profile(), context());
      eq(hits[0].body.model, "claude-modelo-de-teste", "modelo do ambiente");
      eq(G.generatorStatus().model, "claude-modelo-de-teste", "estado mostra o modelo em uso");
    });
  } finally { Deno.env.delete("CLAUDE_MODEL"); }
  eq(G.generatorStatus().model, "claude-opus-5-5", "modelo padrao");
});

const HOOKS = [
  { texto: `Você lava o rosto errado ${EM} e a culpa não é sua.`, formula: "Jeito Errado, Jeito Certo", nota: 81 },
  { texto: "Pare de lavar o rosto com água quente.", formula: "Comando Negativo", nota: 74 },
  { texto: "Você não precisa de dez produtos.", formula: "Permissão", nota: 140 },
];
const BEATS = [1, 2, 3, 4, 5].map((i) => ({ tempo: `${(i - 1) * 4}-${i * 4}s`, fala: `Fala ${i}`, tela: `Tela ${i}` }));
const slidesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ titulo: `Slide ${i + 1}`, texto: `Texto ${i + 1}` }));

Deno.test("claude: roteiro respeita as regras de cada formato", async () => {
  let answer: Any = {};
  await withClaude(() => claudeMessage(answer), async (hits) => {
    // Reel: trechos preenchidos, slides vazios mesmo que o modelo mande, duracao lida.
    answer = { hooks: HOOKS, hook: "", beats: BEATS, slides: slidesOf(2), conceito_visual: "Pia de banheiro, luz da manhã.", duracao_s: 22 };
    const reel = (await claude().script(profile(), PLAN, context({ feedback: "Deixar mais curto", revision: 1 }))).value;
    eq(reel.beats.length, 5, "reel com trechos");
    eq(reel.slides, [], "reel sem slides");
    eq(reel.duracao_s, 22, "duracao do reel");
    eq(reel.hooks.map((h) => h.nota), [81, 74, 100], "nota limitada a 100");
    eq(reel.hook, "Você não precisa de dez produtos.", "sem abertura escolhida, vale a de maior nota");
    assert(!reel.hooks[0].texto.includes(EM), "travessao trocado nas aberturas");
    const user: string = hits[0].body.messages[0].content;
    assert(user.includes("TAREFA: ROTEIRO") && user.includes(PLAN.tema), "mensagem do roteiro leva o plano");
    assert(user.includes('Pedido de ajuste do cliente: "Deixar mais curto"') && user.includes("Versão: 2"), "pedido de ajuste do cliente vai na mensagem");
    eq(hits[0].body.output_config.format.schema.required, ["hooks", "hook", "beats", "slides", "conceito_visual", "duracao_s"], "esquema do roteiro");

    // Carrossel: no maximo 10 slides, sem trechos, sem duracao.
    answer = { hooks: HOOKS, hook: HOOKS[1].texto, beats: BEATS, slides: slidesOf(12), conceito_visual: "Fundo liso.", duracao_s: 0 };
    const car = (await claude().script(profile(), PLAN, context({ formato: "carrossel" }))).value;
    eq([car.slides.length, car.beats.length, car.duracao_s], [10, 0, null], "carrossel cortado em 10 slides, sem trechos");
    eq(car.hook, HOOKS[1].texto, "abertura escolhida pelo modelo");

    // Carrossel curto demais e erro (o motor tenta de novo).
    answer = { ...answer, slides: slidesOf(4) };
    const few = await rejects(() => claude().script(profile(), PLAN, context({ formato: "carrossel" })), "carrossel com 4 slides");
    assert(few.message.includes("4 slides") && !(few instanceof GenConfigError), `mensagem clara: ${few.message}`);

    // Imagem: so o conceito visual.
    answer = { hooks: HOOKS, hook: HOOKS[0].texto, beats: BEATS, slides: slidesOf(7), conceito_visual: "Mãos com sabonete.", duracao_s: 15 };
    const img = (await claude().script(profile(), PLAN, context({ formato: "imagem" }))).value;
    eq([img.beats.length, img.slides.length, img.duracao_s, img.conceito_visual], [0, 0, null, "Mãos com sabonete."], "imagem sem trechos e sem slides");

    // Story: ate 2 quadros de texto na arte, sem fala.
    const story = (await claude().script(profile(), PLAN, context({ formato: "story" }))).value;
    eq(story.beats, [{ tempo: "", fala: "", tela: "Tela 1" }, { tempo: "", fala: "", tela: "Tela 2" }], "story com o texto da arte em tela");
    eq(story.slides, [], "story sem slides");

    // Marcador para preencher nao pode sair.
    answer = { hooks: HOOKS, hook: "Economize {{seu número}} por mês", beats: BEATS, slides: [], conceito_visual: "Cena.", duracao_s: 20 };
    const ph = await rejects(() => claude().script(profile(), PLAN, context()), "marcador no roteiro");
    assert(ph.message.includes("marcador"), ph.message);

    // Sem conceito visual nao ha o que pedir ao gerador de midia.
    answer = { hooks: HOOKS, hook: "Abertura", beats: BEATS, slides: [], conceito_visual: " ", duracao_s: 20 };
    assert((await rejects(() => claude().script(profile(), PLAN, context()), "sem conceito visual")).message.includes("conceito visual"), "erro de conceito visual");
  });
});

Deno.test("claude: legenda, hashtags e story sem chamada", async () => {
  const script = { hooks: [], hook: "Pare de lavar o rosto com água quente.", beats: BEATS, slides: [], conceito_visual: "Pia.", duracao_s: 20 };
  await withClaude(() => claudeMessage({ titulo: "Água quente no rosto", legenda: "  Pare de lavar o rosto com água quente.\n\nComente AGENDA.  ", hashtags: ["#pele", "rotina de pele", "", "#skincare"], alertas: ["Sem prova nova citada."] }), async (hits) => {
    const r = await claude().copy(profile(), PLAN, script, context());
    eq(r.value, { titulo: "Água quente no rosto", legenda: "Pare de lavar o rosto com água quente.\n\nComente AGENDA.", hashtags: "#pele #rotinadepele #skincare", alertas: ["Sem prova nova citada."] }, "copy lida");
    const user: string = hits[0].body.messages[0].content;
    assert(user.includes("TAREFA: LEGENDA") && user.includes("ROTEIRO DO POST") && user.includes("Fala 3"), "mensagem da legenda leva o roteiro");
    eq(hits[0].body.output_config.format.schema.required, ["titulo", "legenda", "hashtags", "alertas"], "esquema da copy");
    // Story: a API do Instagram nao aceita legenda. Nada e pedido ao Claude.
    const s = await claude().copy(profile(), PLAN, script, context({ formato: "story" }));
    eq(hits.length, 1, "story nao gera chamada");
    eq([s.value.titulo, s.value.legenda, s.value.hashtags], [PLAN.tema, "", ""], "story sem legenda e sem hashtags");
    assert(s.value.alertas[0].includes("Story sai sem legenda"), "aviso do story");
    eq(s.usage, { provider: "claude", model: null, input_tokens: 0, output_tokens: 0 }, "uso zerado quando nao ha chamada");
  });
  await withClaude(() => claudeMessage({ titulo: "T", legenda: "", hashtags: [], alertas: [] }), async () => {
    assert((await rejects(() => claude().copy(profile(), PLAN, script, context()), "legenda vazia")).message.includes("legenda vazia"), "erro de legenda vazia");
  });
});

Deno.test("claude: recusa, chave invalida e outros erros", async () => {
  // Recusa do classificador: HTTP 200 com stop_reason refusal.
  await withClaude(() => claudeMessage("", { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: null } }), async () => {
    const e = await rejects(() => claude().plan(profile(), context()), "recusa");
    assert(!(e instanceof GenConfigError) && e.message.includes("recusou") && e.message.includes("bio"), `recusa em portugues: ${e.message}`);
  });
  // 401: erro de configuracao, sem nova tentativa.
  await withClaude(() => claudeError(401, "authentication_error", "invalid x-api-key"), async (hits) => {
    const e = await rejects(() => claude().plan(profile(), context()), "401");
    assert(e instanceof GenConfigError, "401 vira GenConfigError");
    eq((e as Any).code, "chave_claude_invalida", "codigo da chave invalida");
    eq(hits.length, 1, "sem nova tentativa");
  });
  // 500 e 429: erro comum com o status na mensagem, uma chamada so (maxRetries 0).
  for (const [status, type] of [[500, "api_error"], [429, "rate_limit_error"], [400, "invalid_request_error"], [529, "overloaded_error"]] as const) {
    await withClaude(() => claudeError(status, type, "detalhe do fornecedor"), async (hits) => {
      const e = await rejects(() => claude().script(profile(), PLAN, context()), `HTTP ${status}`);
      assert(!(e instanceof GenConfigError) && e.message.includes(String(status)), `status na mensagem: ${e.message}`);
      eq(hits.length, 1, `HTTP ${status} sem nova tentativa do SDK`);
    });
  }
  // Resposta cortada e resposta fora do formato.
  await withClaude(() => claudeMessage('{"tema": "cort', { stop_reason: "max_tokens" }), async () => {
    assert((await rejects(() => claude().plan(profile(), context()), "max_tokens")).message.includes("cortada"), "erro de resposta cortada");
  });
  await withClaude(() => claudeMessage("isto nao e json"), async () => {
    assert((await rejects(() => claude().plan(profile(), context()), "json invalido")).message.includes("fora do formato"), "erro de formato");
  });
  // Servidor fora do ar: erro de rede em portugues.
  Deno.env.set("ANTHROPIC_BASE_URL", "http://127.0.0.1:9"); Deno.env.set("ANTHROPIC_API_KEY", "chave-de-teste");
  try {
    const e = await rejects(() => claude().plan(profile(), context()), "rede");
    assert(e.message.includes("falha de rede"), `erro de rede: ${e.message}`);
  } finally { Deno.env.delete("ANTHROPIC_BASE_URL"); Deno.env.delete("ANTHROPIC_API_KEY"); }
});

// =====================================================================================
// Fabricas: chaves ausentes, trava de demonstracao, estado
// =====================================================================================
Deno.test("fabricas: chave ausente, fornecedor desconhecido e trava de demonstracao", () => {
  for (const k of ["ANTHROPIC_API_KEY", "HIGGSFIELD_API_KEY"]) Deno.env.delete(k);
  const code = (fn: () => unknown, msg: string) => {
    const e = throwsSync(fn, msg);
    assert(e instanceof GenConfigError, `${msg}: GenConfigError`);
    return (e as Any).code as string;
  };
  eq(code(() => G.textGeneratorFor({ text_provider: "claude" }, profile()), "claude sem chave"), "sem_chave_claude", "codigo sem chave do Claude");
  eq(code(() => G.textGeneratorFor({}, profile()), "padrao e claude"), "sem_chave_claude", "sem fornecedor informado vale claude");
  eq(code(() => G.mediaGeneratorFor({ media_provider: "higgsfield" }, profile()), "higgsfield sem chave"), "sem_chave_higgsfield", "codigo sem chave do Higgsfield");
  eq(code(() => G.textGeneratorFor({ text_provider: "gpt" }, profile()), "texto desconhecido"), "fornecedor_desconhecido", "fornecedor de texto desconhecido");
  eq(code(() => G.mediaGeneratorFor({ media_provider: "runway" }, profile()), "midia desconhecida"), "fornecedor_desconhecido", "fornecedor de midia desconhecido");
  // Simulacao so em cliente de demonstracao.
  eq(code(() => G.textGeneratorFor({ text_provider: "simulado" }, profile()), "texto simulado em cliente real"), "simulado_fora_de_demo", "trava de texto");
  eq(code(() => G.mediaGeneratorFor({ media_provider: "simulado" }, profile()), "midia simulada em cliente real"), "simulado_fora_de_demo", "trava de midia");
  eq(G.textGeneratorFor({ text_provider: "simulado" }, profile({ is_demo: true })).provider, "simulado", "texto simulado em demonstracao");
  eq(G.mediaGeneratorFor({ media_provider: "simulado" }, profile({ is_demo: true })).mode, "async", "midia simulada em demonstracao");
  // Estado: so diz se o segredo existe.
  eq(G.generatorStatus(), { text: { claude: false, banco: true, simulado: true }, media: { template: true, manual: true, higgsfield: false, simulado: true }, model: "claude-opus-5-5" }, "estado sem segredos");
  Deno.env.set("ANTHROPIC_API_KEY", "chave-de-teste"); Deno.env.set("HIGGSFIELD_API_KEY", "sem-dois-pontos");
  try {
    eq([G.generatorStatus().text.claude, G.generatorStatus().media.higgsfield], [true, false], "chave do Higgsfield fora do formato nao conta");
    eq(code(() => G.mediaGeneratorFor({ media_provider: "higgsfield" }, profile()), "higgsfield fora do formato"), "chave_higgsfield_invalida", "formato id:segredo");
    Deno.env.set("HIGGSFIELD_API_KEY", "id-teste:segredo-teste");
    eq(G.generatorStatus().media.higgsfield, true, "chave do Higgsfield no formato certo");
    eq(G.textGeneratorFor({ text_provider: "claude" }, profile()).provider, "claude", "claude com chave");
  } finally { for (const k of ["ANTHROPIC_API_KEY", "HIGGSFIELD_API_KEY"]) Deno.env.delete(k); }
});

Deno.test("midia manual: espera o time, nunca fica pronta sozinha", async () => {
  const gen = G.mediaGeneratorFor({ media_provider: "manual" }, profile());
  eq([gen.provider, gen.mode], ["manual", "manual"], "modo manual");
  const job = await gen.start(mediaReq("imagem"), profile());
  assert(job.ref.length > 0 && (job.note ?? "").includes("painel"), "referencia e nota");
  eq((await gen.poll(job.ref, profile())).state, "pending", "sempre pendente");
  eq(G.mediaGeneratorFor({}, profile()).provider, "manual", "sem fornecedor informado vale manual");
});

// =====================================================================================
// Texto simulado
// =====================================================================================
Deno.test("texto simulado: rotulado, deterministico e no formato certo", async () => {
  const demo = profile({ is_demo: true }), gen = G.textGeneratorFor({ text_provider: "simulado" }, demo);
  for (const formato of ["reel", "carrossel", "imagem", "story"] as const) {
    const ctx = context({ formato });
    const plan = await gen.plan(demo, ctx), again = await gen.plan(demo, ctx);
    eq(plan, again, `${formato}: mesmo pedido, mesmo plano`);
    assert(plan.value.tema.startsWith("[Simulação]"), `${formato}: tema rotulado`);
    eq(plan.usage, { provider: "simulado", model: null, input_tokens: null, output_tokens: null }, `${formato}: uso sem tokens`);
    const script = await gen.script(demo, plan.value, ctx);
    eq(script, await gen.script(demo, plan.value, ctx), `${formato}: mesmo roteiro`);
    eq(script.value.hooks.length, 3, `${formato}: tres aberturas`);
    assert(script.value.conceito_visual.startsWith("Simulação"), `${formato}: conceito visual rotulado`);
    const [beats, slides] = [script.value.beats.length, script.value.slides.length];
    if (formato === "reel") assert(beats >= 3 && slides === 0 && script.value.duracao_s! > 0, "reel: trechos, sem slides");
    if (formato === "carrossel") assert(slides >= 6 && slides <= 10 && beats === 0, "carrossel: 6 a 10 slides, sem trechos");
    if (formato === "imagem") assert(beats === 0 && slides === 0, "imagem: sem trechos e sem slides");
    if (formato === "story") assert(beats === 1 && slides === 0 && script.value.beats[0].tela.length > 0, "story: texto na arte");
    const copy = await gen.copy(demo, plan.value, script.value, ctx);
    assert(copy.value.titulo.startsWith("[Simulação]"), `${formato}: titulo rotulado`);
    assert(copy.value.alertas.some((a) => a.includes("Simulação")), `${formato}: alerta de simulacao`);
    if (formato === "story") eq([copy.value.legenda, copy.value.hashtags], ["", ""], "story sem legenda");
    else assert(copy.value.legenda.includes("simulação") && copy.value.hashtags.startsWith("#"), `${formato}: legenda diz que e exemplo`);
    // O revisor nao encontra nada para trocar no texto de exemplo e mantem o rotulo.
    const reviewed = G.reviewCopy(copy.value, demo);
    eq([reviewed.titulo, reviewed.legenda], [copy.value.titulo, copy.value.legenda], `${formato}: revisor nao mexe no texto de exemplo`);
  }
  // Nao repete o tema que acabou de sair, e a nova versao mostra o pedido do cliente nos alertas.
  const first = (await gen.plan(demo, context())).value.tema;
  const second = (await gen.plan(demo, context({ recentes: [first] }))).value.tema;
  assert(first !== second && second.startsWith("[Simulação]"), "tema recente nao se repete");
  const plan = (await gen.plan(demo, context())).value, script = (await gen.script(demo, plan, context())).value;
  const v2 = (await gen.copy(demo, plan, script, context({ feedback: "Trocar a chamada", revision: 1 }))).value;
  assert(v2.titulo.endsWith("(versão 2)") && v2.alertas.some((a) => a.includes("Trocar a chamada")), "nova versao rotulada");
});

// =====================================================================================
// Midia simulada
// =====================================================================================
function mediaReq(formato: MediaRequest["formato"], over: Partial<MediaRequest> = {}): MediaRequest {
  const vertical = formato === "reel" || formato === "story";
  return { formato, proporcao: vertical ? "9:16" : "4:5", prompt: "Pia de banheiro com luz da manhã", slides: [], texto_na_arte: [], duracao_s: formato === "reel" ? 20 : null, briefing: "Briefing de teste", ...over };
}
const SAMPLES = {
  images: ["https://exemplo.test/a.jpg", "https://exemplo.test/b.jpg", "https://exemplo.test/c.jpg", "ftp://invalido/x.jpg"],
  videos: [{ url: "https://exemplo.test/v1.mp4", thumb: "https://exemplo.test/v1.jpg" }, { url: "https://exemplo.test/v2.mp4", thumb: null }],
};

Deno.test("midia simulada: amostras, espera de 30 segundos e erros claros", async () => {
  const demo = profile({ is_demo: true });
  let clock = 1_000_000, setting: string | null = JSON.stringify(SAMPLES);
  const asked: string[] = [];
  const gen = G.mediaGeneratorFor({ media_provider: "simulado" }, demo, { loadSetting: (k) => { asked.push(k); return Promise.resolve(setting); }, now: () => clock });
  eq([gen.provider, gen.mode], ["simulado", "async"], "fornecedor e modo");

  const job = await gen.start(mediaReq("imagem"), demo);
  eq(asked, ["sim_media"], "le a configuracao sim_media");
  assert((job.note ?? "").includes("Simulação"), "nota diz que e simulacao");
  eq((await gen.poll(job.ref, demo)).state, "pending", "pendente logo depois do pedido");
  clock += 29_999;
  eq((await gen.poll(job.ref, demo)).state, "pending", "pendente antes de 30 segundos");
  clock += 1;
  const ready = await gen.poll(job.ref, demo);
  assert(ready.state === "ready" && ready.items.length === 1 && ready.items[0].kind === "image" && SAMPLES.images.slice(0, 3).includes(ready.items[0].url), "imagem de exemplo pronta aos 30 segundos");
  eq((await gen.start(mediaReq("imagem"), demo)).ref.includes(ready.state === "ready" ? ready.items[0].url : "?"), true, "mesmo pedido, mesma amostra");

  // Posts diferentes pegam amostras diferentes (rodizio pelo conteudo do pedido).
  const picked = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const j = await gen.start(mediaReq("imagem", { prompt: `Cena numero ${i}` }), demo);
    const r = await gen.poll(j.ref, demo).then(() => { clock += 30_000; return gen.poll(j.ref, demo); });
    if (r.state === "ready") picked.add(r.items[0].url);
  }
  assert(picked.size >= 2, `rodizio de amostras (${picked.size} diferentes)`);
  assert(!picked.has("ftp://invalido/x.jpg"), "amostra que nao e http fica de fora");

  // Reel pede video, com a capa da amostra.
  const reel = await gen.start(mediaReq("reel"), demo); clock += 30_000;
  const video = await gen.poll(reel.ref, demo);
  assert(video.state === "ready" && video.items.length === 1 && video.items[0].kind === "video" && video.items[0].url.endsWith(".mp4"), "reel devolve video");

  // Carrossel: uma imagem por slide, de 2 a 5, repetindo as amostras em ciclo.
  for (const [n, want] of [[1, 2], [4, 4], [9, 5]] as const) {
    const car = await gen.start(mediaReq("carrossel", { slides: Array.from({ length: n }, (_, i) => `Slide ${i + 1}`) }), demo); clock += 30_000;
    const r = await gen.poll(car.ref, demo);
    assert(r.state === "ready" && r.items.length === want && r.items.every((x) => x.kind === "image"), `carrossel de ${n} slides devolve ${want} imagens`);
  }

  // Sem amostra do tipo pedido: falha com o motivo, sem esperar.
  setting = JSON.stringify({ images: SAMPLES.images, videos: [] });
  const noVideo = await gen.poll((await gen.start(mediaReq("reel"), demo)).ref, demo);
  assert(noVideo.state === "failed" && noVideo.error.includes("vídeo de exemplo"), "reel sem video de exemplo falha com motivo");
  setting = null;
  const noCfg = await gen.poll((await gen.start(mediaReq("imagem"), demo)).ref, demo);
  assert(noCfg.state === "failed" && noCfg.error.includes("imagem de exemplo"), "sem configuracao falha com motivo");
  setting = "{nao e json";
  eq((await gen.poll((await gen.start(mediaReq("story"), demo)).ref, demo)).state, "failed", "configuracao invalida falha");
  eq((await gen.poll("lixo", demo)).state, "failed", "referencia invalida falha");
});

// =====================================================================================
// Higgsfield (servidor falso da API REST)
// =====================================================================================
const HF_IMAGE = "/higgsfield-ai/soul/standard", HF_VIDEO = "/kling-video/v2.5-turbo/pro/image-to-video";
type Fake = { jobs: Map<string, Any>; byKey: Map<string, string>; reject: ((hit: Hit) => Response | null) | null };

async function withHiggsfield(run: (fake: Fake, hits: Hit[]) => Promise<void>) {
  const fake: Fake = { jobs: new Map(), byKey: new Map(), reject: null };
  await withServer((hit, base) => {
    if (hit.headers.get("authorization") !== "Key id-teste:segredo-teste") return jsonRes({ detail: "Invalid credentials" }, 401);
    const status = /^\/requests\/([^/]+)\/status$/.exec(hit.path), cancel = /^\/requests\/([^/]+)\/cancel$/.exec(hit.path);
    if (hit.method === "GET" && status) {
      const job = fake.jobs.get(status[1]);
      return job ? jsonRes({ request_id: status[1], ...job.state }) : jsonRes({ detail: "Request not found" }, 404);
    }
    if (hit.method === "POST" && cancel) return new Response(null, { status: 202 });
    if (hit.method === "POST" && (hit.path === HF_IMAGE || hit.path === HF_VIDEO)) {
      const refused = fake.reject?.(hit);
      if (refused) return refused;
      // Idempotencia como na documentacao: a mesma chave devolve o mesmo pedido, sem criar outro.
      const key = hit.headers.get("idempotency-key") ?? "";
      const id = fake.byKey.get(key) ?? crypto.randomUUID();
      if (!fake.byKey.has(key)) { fake.byKey.set(key, id); fake.jobs.set(id, { path: hit.path, body: hit.body, state: { status: "queued" } }); }
      return jsonRes({ status: "queued", request_id: id, status_url: `${base}/requests/${id}/status`, cancel_url: `${base}/requests/${id}/cancel`, expires_after: 604800 });
    }
    return jsonRes({ detail: "Not found" }, 404);
  }, async (base, hits) => {
    Deno.env.set("HIGGSFIELD_BASE_URL", base);
    Deno.env.set("HIGGSFIELD_API_KEY", "id-teste:segredo-teste");
    try { await run(fake, hits); } finally { Deno.env.delete("HIGGSFIELD_BASE_URL"); Deno.env.delete("HIGGSFIELD_API_KEY"); }
  });
}
const higgsfield = () => G.mediaGeneratorFor({ media_provider: "higgsfield" }, profile());
const submits = (hits: Hit[], path?: string) => hits.filter((h) => h.method === "POST" && (path ? h.path === path : h.path === HF_IMAGE || h.path === HF_VIDEO));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const done = (fake: Fake, id: string, out: Any) => { fake.jobs.get(id).state = { status: "completed", expires_at: "2026-11-22T12:00:00Z", ...out }; };

Deno.test("higgsfield: imagem 4:5 e story 9:16", async () => {
  await withHiggsfield(async (fake, hits) => {
    const gen = higgsfield();
    eq([gen.provider, gen.mode], ["higgsfield", "async"], "fornecedor e modo");
    const longText = "PROMOÇÃO DE NOVEMBRO COM TEXTO MUITO LONGO PARA CABER NA ARTE E QUE NAO DEVE VIRAR TEXTO DESENHADO PELO GERADOR DE IMAGEM";
    const job = await gen.start(mediaReq("imagem", { texto_na_arte: [longText] }), profile());
    const sent = submits(hits);
    eq(sent.length, 1, "um envio");
    eq(sent[0].path, HF_IMAGE, "endpoint de imagem");
    eq(Object.keys(sent[0].body).sort(), ["aspect_ratio", "prompt"], "so os campos documentados nas duas fontes");
    eq(sent[0].body.aspect_ratio, "4:5", "proporcao 4:5");
    assert(UUID.test(sent[0].headers.get("idempotency-key") ?? ""), "chave de idempotencia");
    const prompt: string = sent[0].body.prompt;
    assert(prompt.startsWith("Pia de banheiro com luz da manhã.") && prompt.includes("Sem texto"), `pedido descreve a cena e pede arte sem texto: ${prompt}`);
    assert(!prompt.includes(longText) && prompt.includes(longText.slice(0, 40)), "texto da arte entra so como pista curta");
    assert((job.note ?? "").includes("sem texto"), "nota avisa que a arte sai sem texto");
    const id = [...fake.jobs.keys()][0];
    eq((await gen.poll(job.ref, profile())).state, "pending", "na fila: pendente");
    fake.jobs.get(id).state = { status: "in_progress" };
    eq((await gen.poll(job.ref, profile())).state, "pending", "em andamento: pendente");
    fake.jobs.get(id).state = { status: "estado_novo_do_fornecedor" };
    eq((await gen.poll(job.ref, profile())).state, "pending", "estado desconhecido: pendente");
    done(fake, id, { images: [{ url: "https://cdn.hf.test/img-1.png" }] });
    eq(await gen.poll(job.ref, profile()), { state: "ready", items: [{ kind: "image", url: "https://cdn.hf.test/img-1.png", thumb: null }] }, "imagem pronta");
    assert(hits.filter((h) => h.method === "GET").every((h) => h.path === `/requests/${id}/status`), "consulta pelo caminho documentado");

    await gen.start(mediaReq("story"), profile());
    eq(submits(hits)[1].body.aspect_ratio, "9:16", "story em 9:16");
    assert(submits(hits)[1].headers.get("idempotency-key") !== sent[0].headers.get("idempotency-key"), "chave nova para cada geracao");
  });
});

Deno.test("higgsfield: carrossel com um pedido por slide", async () => {
  await withHiggsfield(async (fake, hits) => {
    const gen = higgsfield();
    const slides = ["Slide 1: Capa. Promessa", "Slide 2: A aposta. Motivo", "Slide 3: Resumo. Lista"];
    const job = await gen.start(mediaReq("carrossel", { slides, texto_na_arte: ["Capa", "A aposta", "Resumo"] }), profile());
    const sent = submits(hits);
    eq(sent.length, 3, "um envio por slide");
    assert(sent.every((h) => h.path === HF_IMAGE && h.body.aspect_ratio === "4:5"), "todas em 4:5");
    eq(new Set(sent.map((h) => h.headers.get("idempotency-key"))).size, 3, "chaves de idempotencia diferentes");
    const ids: string[] = JSON.parse(job.ref).ids;
    eq(ids.length, 3, "tres pedidos na referencia");
    // A ordem da referencia e a ordem dos slides.
    ids.forEach((id, i) => assert(fake.jobs.get(id).body.prompt.includes(`Imagem ${i + 1} de 3`) && fake.jobs.get(id).body.prompt.includes(["Capa", "A aposta", "Resumo"][i]), `slide ${i + 1} na ordem`));
    done(fake, ids[0], { images: [{ url: "https://cdn.hf.test/s1.png" }] });
    done(fake, ids[2], { images: [{ url: "https://cdn.hf.test/s3.png" }] });
    const partial = await gen.poll(job.ref, profile());
    assert(partial.state === "pending" && (partial.note ?? "").includes("2 de 3") && !("ref" in partial && partial.ref), "duas de tres: pendente, mesma referencia");
    done(fake, ids[1], { images: [{ url: "https://cdn.hf.test/s2.png" }] });
    const ready = await gen.poll(job.ref, profile());
    eq(ready.state === "ready" ? ready.items.map((i) => i.url) : [], ["https://cdn.hf.test/s1.png", "https://cdn.hf.test/s2.png", "https://cdn.hf.test/s3.png"], "imagens na ordem dos slides");

    // Mais de 10 slides: so 10 pedidos.
    const before = submits(hits).length;
    await gen.start(mediaReq("carrossel", { slides: Array.from({ length: 12 }, (_, i) => `Slide ${i + 1}: T. X`) }), profile());
    eq(submits(hits).length - before, 10, "teto de 10 imagens");

    // Uma imagem do carrossel bloqueada derruba o pedido, dizendo qual.
    const j2 = await gen.start(mediaReq("carrossel", { slides: slides.slice(0, 2) }), profile());
    const [a, b]: string[] = JSON.parse(j2.ref).ids;
    done(fake, a, { images: [{ url: "https://cdn.hf.test/x.png" }] });
    fake.jobs.get(b).state = { status: "nsfw" };
    const blocked = await gen.poll(j2.ref, profile());
    assert(blocked.state === "failed" && blocked.error.includes("Imagem 2 de 2") && blocked.error.includes("moderação"), "nsfw em um slide falha o carrossel");
  });
});

Deno.test("higgsfield: reel em duas etapas (imagem base, depois video)", async () => {
  await withHiggsfield(async (fake, hits) => {
    const gen = higgsfield();
    const job = await gen.start(mediaReq("reel", { texto_na_arte: ["Texto de tela"] }), profile());
    eq(submits(hits).length, 1, "so a imagem base no inicio");
    eq([submits(hits)[0].path, submits(hits)[0].body.aspect_ratio], [HF_IMAGE, "9:16"], "imagem base em 9:16");
    assert((job.note ?? "").includes("10 segundos") && (job.note ?? "").includes("sem a fala"), "nota explica o limite do video gerado");
    const stillId: string = JSON.parse(job.ref).ids[0];
    const waiting = await gen.poll(job.ref, profile());
    assert(waiting.state === "pending" && !("ref" in waiting && waiting.ref), "imagem base na fila: pendente, sem trocar a referencia");
    eq(submits(hits, HF_VIDEO).length, 0, "video ainda nao pedido");

    // Imagem base pronta: a consulta pede o video e devolve a referencia nova, sem esperar.
    done(fake, stillId, { images: [{ url: "https://cdn.hf.test/base.png" }] });
    const moved = await gen.poll(job.ref, profile());
    assert(moved.state === "pending" && typeof moved.ref === "string" && moved.ref !== job.ref && (moved.note ?? "").includes("vídeo"), "passa para a etapa de video com referencia nova");
    const videoSubmit = submits(hits, HF_VIDEO);
    eq(videoSubmit.length, 1, "um pedido de video");
    eq(Object.keys(videoSubmit[0].body).sort(), ["duration", "image_url", "prompt"], "campos documentados do imagem para video");
    eq([videoSubmit[0].body.image_url, videoSubmit[0].body.duration], ["https://cdn.hf.test/base.png", 10], "usa a imagem base e 10 segundos");
    assert(videoSubmit[0].body.prompt.length > 10 && !videoSubmit[0].body.prompt.includes("Texto de tela"), "pedido do video sem o texto de tela");

    // Se o motor consultar a referencia antiga de novo (falha antes de gravar a nova), o video nao e pedido em dobro.
    const again = await gen.poll(job.ref, profile());
    eq(again.state === "pending" ? again.ref : null, moved.state === "pending" ? moved.ref : "?", "mesma chave de idempotencia, mesmo pedido de video");
    eq(submits(hits, HF_VIDEO).map((h) => h.headers.get("idempotency-key")).filter((k, i, all) => all.indexOf(k) === i).length, 1, "a chave do video nao muda");
    eq([...fake.jobs.values()].filter((j) => j.path === HF_VIDEO).length, 1, "um unico video criado no fornecedor");

    const videoRef = moved.state === "pending" ? moved.ref! : "";
    const videoId: string = JSON.parse(videoRef).ids[0];
    eq((await gen.poll(videoRef, profile())).state, "pending", "video em geracao: pendente");
    done(fake, videoId, { video: { url: "https://cdn.hf.test/reel.mp4" } });
    eq(await gen.poll(videoRef, profile()), { state: "ready", items: [{ kind: "video", url: "https://cdn.hf.test/reel.mp4", thumb: null }] }, "video pronto");

    // Reel curto pede 5 segundos (o modelo so aceita 5 ou 10).
    const short = await gen.start(mediaReq("reel", { duracao_s: 6 }), profile());
    done(fake, JSON.parse(short.ref).ids[0], { images: [{ url: "https://cdn.hf.test/base2.png" }] });
    await gen.poll(short.ref, profile());
    eq(submits(hits, HF_VIDEO).at(-1)!.body.duration, 5, "duracao de 5 segundos");

    // Video que falha na segunda etapa.
    const failing = await gen.poll(short.ref, profile());
    const failId: string = JSON.parse(failing.state === "pending" ? failing.ref! : "{}").ids[0];
    fake.jobs.get(failId).state = { status: "failed", error: "Generation failed" };
    const failed = await gen.poll(failing.state === "pending" ? failing.ref! : "", profile());
    assert(failed.state === "failed" && failed.error.includes("Generation failed"), "falha do video com o motivo do fornecedor");
  });
});

Deno.test("higgsfield: pedidos que falham, bloqueados, cancelados e inexistentes", async () => {
  await withHiggsfield(async (fake) => {
    const gen = higgsfield();
    const start = async () => { const j = await gen.start(mediaReq("imagem"), profile()); return { ref: j.ref, id: JSON.parse(j.ref).ids[0] as string }; };
    const a = await start();
    fake.jobs.get(a.id).state = { status: "failed", error: "Generation failed" };
    const failed = await gen.poll(a.ref, profile());
    assert(failed.state === "failed" && failed.error.includes("não conseguiu gerar") && failed.error.includes("Generation failed"), "failed vira falha com motivo");
    const b = await start();
    fake.jobs.get(b.id).state = { status: "nsfw" };
    const nsfw = await gen.poll(b.ref, profile());
    assert(nsfw.state === "failed" && nsfw.error.includes("moderação") && nsfw.error.includes("nsfw"), "nsfw vira falha de moderacao");
    const c = await start();
    fake.jobs.get(c.id).state = { status: "canceled" };
    const canceled = await gen.poll(c.ref, profile());
    assert(canceled.state === "failed" && canceled.error.includes("cancelado"), "canceled vira falha");
    const d = await start();
    fake.jobs.delete(d.id);
    const gone = await gen.poll(d.ref, profile());
    assert(gone.state === "failed" && gone.error.includes("404"), "pedido inexistente vira falha");
    const e = await start();
    done(fake, e.id, { images: [] });
    const empty = await gen.poll(e.ref, profile());
    assert(empty.state === "failed" && empty.error.includes("sem devolver a imagem"), "concluido sem imagem vira falha");
    eq((await gen.poll("isto nao e uma referencia", profile())).state, "failed", "referencia invalida");
    eq((await gen.poll(JSON.stringify({ v: 1, etapa: "outra", ids: ["x"] }), profile())).state, "failed", "etapa desconhecida");
  });
});

Deno.test("higgsfield: erros no envio e na consulta", async () => {
  await withHiggsfield(async (fake, hits) => {
    const gen = higgsfield();
    // 401: chave recusada e erro de configuracao.
    Deno.env.set("HIGGSFIELD_API_KEY", "id-errado:segredo");
    const e401 = await rejects(() => gen.start(mediaReq("imagem"), profile()), "401");
    assert(e401 instanceof GenConfigError && (e401 as Any).code === "chave_higgsfield_invalida", "401 vira GenConfigError");
    Deno.env.set("HIGGSFIELD_API_KEY", "id-teste:segredo-teste");

    // 403 (saldo), 429 (fila cheia, com Retry-After) e 422 (validacao).
    fake.reject = () => jsonRes({ detail: "Insufficient balance" }, 403);
    const e403 = await rejects(() => gen.start(mediaReq("imagem"), profile()), "403");
    assert(e403 instanceof GenConfigError && e403.message.includes("403") && e403.message.includes("saldo"), `403 explica o saldo: ${e403.message}`);
    fake.reject = () => jsonRes({ detail: { code: "account_queue_full", message: "Too many queued generations for this account", retryable: true } }, 429, { "retry-after": "30" });
    const e429 = await rejects(() => gen.start(mediaReq("imagem"), profile()), "429");
    assert(!(e429 instanceof GenConfigError) && e429.message.includes("429") && e429.message.includes("30 segundos"), `429 com a espera pedida: ${e429.message}`);
    fake.reject = () => jsonRes({ detail: "aspect_ratio: value is not a valid enumeration member" }, 422);
    const e422 = await rejects(() => gen.start(mediaReq("imagem"), profile()), "422");
    assert(e422.message.includes("422") && e422.message.includes("aspect_ratio"), `422 leva o detalhe: ${e422.message}`);

    // 500 uma vez: repete com a MESMA chave de idempotencia e segue.
    let failures = 1;
    fake.reject = () => (failures-- > 0 ? jsonRes({ detail: "boom" }, 500) : null);
    const before = submits(hits).length;
    const ok = await gen.start(mediaReq("imagem"), profile());
    const pair = submits(hits).slice(before);
    eq(pair.length, 2, "duas tentativas");
    eq(pair[0].headers.get("idempotency-key"), pair[1].headers.get("idempotency-key"), "mesma chave nas duas tentativas");
    assert(JSON.parse(ok.ref).ids.length === 1, "pedido aceito na segunda tentativa");
    // 500 duas vezes: erro com o status.
    fake.reject = () => jsonRes({ detail: "boom" }, 500);
    const e500 = await rejects(() => gen.start(mediaReq("imagem"), profile()), "500");
    assert(e500.message.includes("500") && !(e500 instanceof GenConfigError), `500 com status: ${e500.message}`);

    // Carrossel com um slide recusado: o que entrou na fila e cancelado e o erro sobe.
    let n = 0;
    fake.reject = () => (++n === 2 ? jsonRes({ detail: "prompt rejected" }, 400) : null);
    const cancelsBefore = hits.filter((h) => h.path.endsWith("/cancel")).length;
    const eCar = await rejects(() => gen.start(mediaReq("carrossel", { slides: ["Slide 1: A. a", "Slide 2: B. b", "Slide 3: C. c"] }), profile()), "carrossel recusado");
    assert(eCar.message.includes("400"), `erro do slide recusado: ${eCar.message}`);
    eq(hits.filter((h) => h.path.endsWith("/cancel")).length - cancelsBefore, 2, "os dois pedidos aceitos foram cancelados");
    fake.reject = null;

    // Consulta com a chave trocada: erro de configuracao.
    const job = await gen.start(mediaReq("imagem"), profile());
    Deno.env.set("HIGGSFIELD_API_KEY", "id-errado:segredo");
    assert((await rejects(() => gen.poll(job.ref, profile()), "consulta 401")) instanceof GenConfigError, "401 na consulta vira GenConfigError");
    Deno.env.set("HIGGSFIELD_API_KEY", "id-teste:segredo-teste");
    assert((await rejects(() => gen.start(mediaReq("carrossel", { slides: ["um so"] }), profile()), "carrossel de 1 slide")).message.includes("2 slides"), "carrossel precisa de 2 slides");
  });
  // Fornecedor fora do ar: erro de rede em portugues, depois de uma nova tentativa.
  Deno.env.set("HIGGSFIELD_BASE_URL", "http://127.0.0.1:9"); Deno.env.set("HIGGSFIELD_API_KEY", "id-teste:segredo-teste");
  try {
    const e = await rejects(() => higgsfield().start(mediaReq("imagem"), profile()), "rede");
    assert(e.message.includes("não respondeu"), `erro de rede: ${e.message}`);
  } finally { Deno.env.delete("HIGGSFIELD_BASE_URL"); Deno.env.delete("HIGGSFIELD_API_KEY"); }
});

// =====================================================================================
// Revisor de texto (reviewCopy)
// =====================================================================================
const copyOf = (legenda: string, hashtags = "#pele", titulo = "Título", alertas: string[] = []): Copy => ({ titulo, legenda, hashtags, alertas });
const has = (c: Copy, piece: string) => c.alertas.some((a) => a.includes(piece));

Deno.test("revisor: travessao, caracteres invisiveis e aspas", () => {
  const r = G.reviewCopy(copyOf(
    `Cuidar da pele${ZWSP} leva tempo ${EM} e tudo bem.\nResultado em 5${EN}10 minutos ${EN} sem pressa.\nEla disse ${LQ}funciona${RQ}${DOUBLE}e voltou.${NBSP}Fim.`,
    "#pele", `Rotina ${EM} manhã`), profile());
  eq(r.legenda, 'Cuidar da pele leva tempo, e tudo bem.\nResultado em 5-10 minutos, sem pressa.\nEla disse "funciona", e voltou. Fim.', "texto limpo");
  eq(r.titulo, "Rotina, manhã", "titulo limpo");
  for (const ch of [EM, EN, ZWSP, NBSP, LQ, RQ]) assert(!(r.legenda + r.titulo + r.hashtags).includes(ch), `sem o caractere U+${ch.codePointAt(0)!.toString(16)}`);
  assert(has(r, "Travessão trocado por vírgula") && has(r, "Caracteres invisíveis removidos") && has(r, "Aspas curvas"), "mudancas descritas nos alertas");
  // Emoji composto (com juncao de largura zero) continua inteiro.
  const emoji = cp(0x1f469) + ZWJ + cp(0x1f4bb);
  eq(G.reviewCopy(copyOf(`Trabalho remoto ${emoji} hoje.`), profile()).legenda, `Trabalho remoto ${emoji} hoje.`, "emoji composto preservado");
});

Deno.test("revisor: lexico com cara de IA, saudacao e iscas", () => {
  const r = G.reviewCopy(copyOf("Olá, pessoal! No mundo acelerado de hoje, a hidratação é crucial. Além disso, utilizamos ativos inovadores.\n\nVale ressaltar que a rotina é simples. Pense nisso.\nSegue para mais dicas de pele!"), profile());
  eq(r.legenda, "Hoje, a hidratação é importante. Também, usamos ativos novos.\n\nA rotina é simples.", "trocas e cortes aplicados");
  assert(has(r, "Saudação removida") && has(r, '"além disso" por "também"') && has(r, '"utilizamos" por "usamos"') && has(r, '"vale ressaltar que"') && has(r, '"segue para mais"'), "cada troca aparece nos alertas");
  // Palavra acentuada no comeco da frase e maiusculas (o \b do JavaScript nao veria o "É").
  eq(G.reviewCopy(copyOf("É IMPORTANTE DESTACAR QUE a pele muda. É de suma importância hidratar."), profile()).legenda, "A pele muda. É importante hidratar.", "fronteira de palavra com acento");
  // Corte em item de lista e depois de dois-pontos nao deixa pontuacao solta.
  eq(G.reviewCopy(copyOf("Passos:\n- Em resumo, hidrate.\n- Pense nisso.\nDica: em resumo, proteja a pele."), profile({ voice: {} })).legenda, "Passos:\n- Hidrate.\n\nDica: proteja a pele.", "corte em lista e em oracao");
  // Nao troca pedaco de palavra nem vocabulario legitimo do cliente.
  const kept = "O óleo essencial e o café robusta combinam. Contudologia não existe.";
  eq(G.reviewCopy(copyOf(kept), profile()).legenda, kept, "palavras legitimas ficam");
  // A chamada para acao e as palavras que a marca escolheu nao sao cortadas.
  const brand = profile({ voice: { cta: "Comenta aqui embaixo a palavra AGENDA.", usa: "inovador" } });
  const own = "Tratamento inovador para a sua rotina.\n\nComenta aqui embaixo a palavra AGENDA.";
  eq(G.reviewCopy(copyOf(own), brand).legenda, own, "vocabulario da marca respeitado");
  eq(G.reviewCopy(copyOf(own), profile({ voice: {} })).legenda, "Tratamento novo para a sua rotina.", "sem a marca pedir, a isca sai e a palavra e trocada");
});

Deno.test("revisor: hashtags e link fora da legenda, limites de 30 e de 2200", () => {
  const p = profile();
  const r = G.reviewCopy(copyOf("Rotina de pele em três passos #pele.\nAgende em https://aurora.example/agenda. Ou veja www.aurora.example e aurora.example/horarios\n#rotina #Pele", "#skincare #fyp #viral #SkinCare limpeza #123 #parati"), p);
  eq(r.legenda, "Rotina de pele em três passos.\nAgende. Ou veja e", "legenda sem hashtag e sem link");
  eq(r.hashtags, "#skincare #limpeza #pele #rotina", "hashtags sem genericas, sem repetidas, com as que estavam na legenda");
  assert(has(r, "Link removido") && has(r, "Hashtags tiradas do meio da legenda") && has(r, "Hashtags genéricas removidas: #fyp, #viral, #parati") && has(r, "repetidas") && has(r, "inválidas"), "mudancas descritas");
  // Teto de 30 hashtags.
  const many = Array.from({ length: 35 }, (_, i) => `#tema${String.fromCharCode(97 + (i % 26))}${i}`).join(" ");
  const capped = G.reviewCopy(copyOf("Texto.", many), p);
  eq(capped.hashtags.split(" ").length, 30, "no maximo 30 hashtags");
  assert(has(capped, "limite de 30"), "corte de hashtags descrito");
  // Legenda + link + hashtags cabem em 2200, cortando em fim de frase.
  const long = Array.from({ length: 150 }, (_, i) => `Frase número ${i} sobre a rotina de pele.`).join(" ");
  const fit = G.reviewCopy(copyOf(long, "#pele #rotina"), profile({ voice: { provas: "" }, context: "" }));
  const total = [fit.legenda, p.default_link, fit.hashtags].join("\n\n").length;
  assert(total <= 2200 && total > 2000, `conjunto cabe em 2200 (${total})`);
  assert(fit.legenda.endsWith("pele.") && has(fit, "Legenda encurtada"), "corte em fim de frase, descrito");
  eq(G.reviewCopy(copyOf("Curta.", "#pele"), p).alertas, [], "texto limpo nao gera alerta");
});

Deno.test("revisor: avisos de numero sem prova, promessa e palavras que a marca evita", () => {
  const p = profile();
  const r = G.reviewCopy(copyOf("87% das clientes voltam. Hoje 93% aprovam e sai por R$ 199. Resultado garantido e barato, um milagre. Não é só limpeza, é cuidado."), p);
  assert(has(r, 'número sem prova cadastrada no perfil ("93%", "R$ 199")'), `numero sem prova: ${JSON.stringify(r.alertas)}`);
  assert(!r.alertas.some((a) => a.includes('"87%"')), "numero que esta nas provas nao e apontado");
  assert(has(r, "promessa de garantia") && has(r, "alegação de saúde"), "promessas apontadas");
  assert(has(r, 'usa "barato", "milagre", da lista de palavras que a marca evita'), "palavras que a marca evita");
  assert(has(r, '"não é só X, é Y"'), "estrutura com cara de IA");
  eq(r.legenda.includes("93%"), true, "avisos nao mudam o texto");
  assert(has(G.reviewCopy(copyOf("Veja o antes e depois da Ana."), p), 'cita "antes e depois", da lista de temas proibidos'), "tema proibido apontado");
  assert(has(G.reviewCopy(copyOf("Economize {{seu número}} por mês."), p), "marcador para preencher"), "marcador apontado");
});

Deno.test("revisor: rodar duas vezes da o mesmo resultado", () => {
  const p = profile();
  const samples = [
    `Oi, gente! No mundo acelerado de hoje, cuidar da pele${ZWSP} é crucial ${EM} e vale ressaltar que 93% voltam.\n\nAlém disso, utilizamos protocolos ${LQ}inovadores${RQ}. Pense nisso.\n\nAgende em https://aurora.example/agenda #pele #viral`,
    "Em resumo, o tratamento é barato e garantido. Ganhe R$ 500! Segue para mais dicas!\n\nE você?",
    "Sem sombra de dúvida!\nHoje vou te mostrar como hidratar. É importante destacar que isso ajuda, sem sombra de dúvida.",
    Array.from({ length: 200 }, (_, i) => `Frase ${i} ${EM} com travessão e além disso mais texto.`).join("\n"),
    "", "#so #hashtags #aqui", `${EM}${EM} ${EN} ...`,
  ];
  for (const [i, legenda] of samples.entries()) {
    const once = G.reviewCopy(copyOf(legenda, "#Pele #pele #fyp limpeza #estética " + "#tag".repeat(3), `Título ${EM} ${i}`, ["Aviso do gerador."]), p);
    const twice = G.reviewCopy(once, p);
    eq(twice, once, `amostra ${i} estavel na segunda passada`);
    assert(once.alertas[0] === "Aviso do gerador.", "alertas do gerador ficam");
    assert(!/#|https?:/.test(once.legenda), `amostra ${i}: sem hashtag e sem link na legenda`);
    assert([once.legenda, p.default_link, once.hashtags].filter(Boolean).join("\n\n").length <= 2200, `amostra ${i}: cabe em 2200`);
  }
  // Entrada torta nao derruba o revisor.
  eq(G.reviewCopy({ titulo: null, legenda: undefined, hashtags: 5, alertas: "x" } as Any, p), { titulo: "", legenda: "", hashtags: "", alertas: [] }, "campos invalidos viram vazio");
});

Deno.test("revisor: hashtag colada, mencao, e-mail e titulo", () => {
  const p = profile({ voice: {} });
  const r = G.reviewCopy(copyOf("O #1 erro da rotina#pele é pular o protetor. Fale com @inovador ou contato@inovador.com.br.", "#pele#rotina,#Rotina;limpeza"), p);
  eq(r.legenda, "O #1 erro da rotina é pular o protetor. Fale com @inovador ou contato@inovador.com.br.", "numero com # fica, hashtag colada sai, mencao e e-mail intactos");
  eq(r.hashtags, "#pele #rotina #limpeza", "hashtags coladas sao separadas");
  // Titulo: uma linha so, sem travessao, no tamanho do cartao, sem meio emoji no corte.
  const emoji = cp(0x1f469) + ZWJ + cp(0x1f4bb);
  const long = G.reviewCopy(copyOf("Texto.", "#pele", `Linha um\n\nlinha  dois ${EM} ${"x".repeat(108)}${emoji}${emoji}`), p);
  assert(long.titulo.length <= 120 && long.titulo.startsWith("Linha um linha dois, x") && !long.titulo.endsWith(ZWJ), `titulo cortado sem partir emoji: ${long.titulo.length}`);
  eq(G.reviewCopy(long, p), long, "titulo estavel na segunda passada");
});

// Textos montados ao acaso (com semente fixa) a partir das pecas que o revisor trata: o resultado tem de ser estavel
// na segunda passada e respeitar os limites, qualquer que seja a combinacao.
Deno.test("revisor: combinacoes ao acaso continuam estaveis e dentro dos limites", () => {
  const pool = [
    "Além disso", "além disso,", "vale ressaltar que", "Em resumo,", "Pense nisso.", "sem sombra de dúvida", "No mundo acelerado de hoje,", "é crucial", "É importante destacar que",
    "utilizamos", "inovador", "hoje vou te mostrar", "Segue para mais dicas!", "Me conta nos comentários qual é a sua.", "Comenta aqui embaixo", "Oi, gente!", "Olá!", "Bom dia,",
    "a pele", "o cliente", "87%", "R$ 199", "garantido", EM, ` ${EM} `, ` ${EN} `, "5" + EN + "10", DOUBLE, ZWSP, NBSP, LQ, RQ, cp(0x2026), cp(0x2022) + " item", "...", ".", "!", "?", ",", ":",
    "\n", "\n\n\n", " ", "#pele", "#viral", "#123", "https://exemplo.test/x.", "www.exemplo.test", "exemplo.test/agenda", "em https://a.test/b", "@marca", cp(0x1f469) + ZWJ + cp(0x1f4bb),
    "E você?", "Não é só limpeza, é cuidado.", "{{seu número}}", "Contudo,", "TODAVIA", "barato",
  ];
  let seed = 20261115;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const pick = () => pool[Math.floor(rnd() * pool.length)];
  const p = profile();
  for (let i = 0; i < 400; i++) {
    const size = 1 + Math.floor(rnd() * (i % 10 === 0 ? 600 : 40));
    let legenda = "";
    for (let j = 0; j < size; j++) legenda += pick() + (rnd() < 0.7 ? " " : "");
    const tags = Array.from({ length: Math.floor(rnd() * 40) }, pick).join(rnd() < 0.5 ? " " : ",");
    const once = G.reviewCopy({ titulo: legenda.slice(0, 150), legenda, hashtags: tags, alertas: [] }, p);
    eq(G.reviewCopy(once, p), once, `caso ${i} estavel`);
    const all = once.titulo + once.legenda + once.hashtags;
    for (const ch of [EM, EN, ZWSP, NBSP, LQ, RQ]) assert(!all.includes(ch), `caso ${i}: sem U+${ch.codePointAt(0)!.toString(16)}`);
    assert(!/#(?=[\p{N}_]*\p{L})[\p{L}\p{N}_]+/u.test(once.legenda) && !/https?:\/\//.test(once.legenda), `caso ${i}: sem hashtag e sem link na legenda`);
    assert([once.legenda, p.default_link, once.hashtags].filter(Boolean).join("\n\n").length <= 2200, `caso ${i}: cabe em 2200`);
    assert(once.hashtags.split(" ").filter(Boolean).length <= 30 && once.hashtags.length <= 600 && once.titulo.length <= 120, `caso ${i}: limites de hashtags e de titulo`);
  }
});

// =====================================================================================
// Higiene dos arquivos
// =====================================================================================
Deno.test("arquivos: sem travessao e sem caractere invisivel no codigo", async () => {
  for (const file of ["../lib/generators.ts", "../lib/humanize.ts", "../lib/prompts.ts", "./generators_test.ts"]) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    const bad = [...src].filter((c) => [0x2014, 0x2013, 0x2015].includes(c.codePointAt(0)!) || /\p{Cf}/u.test(c) || (/\p{Cc}/u.test(c) && c !== "\n"));
    eq(bad.map((c) => "U+" + c.codePointAt(0)!.toString(16)), [], `${file} sem caracteres proibidos`);
    assert(!src.includes(DOUBLE), `${file} sem dois hifens usados como travessao`);
  }
});
