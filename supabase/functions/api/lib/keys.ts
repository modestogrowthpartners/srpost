// Chaves e integracoes: o que esta configurado, o que falta, o que cada chave libera, onde colar e um teste real.
// O teste faz uma chamada barata e de leitura ao fornecedor. Nenhuma rota devolve o valor de uma chave.
import Anthropic from "npm:@anthropic-ai/sdk@1";
import { db, getSetting, HttpError, igConfigured, json, must, readJson, str } from "./core.ts";
import { claudeConfigured, claudeModel, higgsfieldConfigured, loadSecrets, PANEL_SECRETS, secret, secretSource, uploadPostKeyConfigured } from "./secrets.ts";
import { templatePing } from "./template.ts";

type Item = {
  id: string; name: string; configured: boolean; required: boolean; source: string | null;
  secret: string | null;       // nome do segredo que pode ser colado no painel (null = nao e colado aqui)
  unlocks: string; without: string; where: string; format: string | null; note: string | null;
};

async function items(): Promise<Item[]> {
  const configId = Deno.env.get("IG_LOGIN_CONFIG_ID") ?? await getSetting("ig_login_config_id");
  const src = (n: string) => secretSource(n) === "funcao" ? "segredo da função no Supabase" : secretSource(n) === "painel" ? "colada neste painel" : null;
  return [
    {
      id: "instagram", name: "Instagram (app da Meta)", configured: igConfigured() && Boolean(configId), required: true,
      source: igConfigured() ? "segredos da função no Supabase" : null, secret: null,
      unlocks: "Conexão do Instagram de cada cliente pelo portal e publicação de feed, Reels, carrossel e stories.",
      without: "Nenhum cliente consegue conectar o Instagram.",
      where: "Supabase, Edge Functions, Secrets: IG_APP_ID e IG_APP_SECRET (ID e chave secreta do app da Meta com Facebook Login for Business). O ID da configuração de login fica no banco.",
      format: null,
      note: "Enquanto o app da Meta não passar pela revisão, só contas com papel no app conseguem conectar.",
    },
    {
      id: "tiktok", name: "TikTok (provedor Upload-Post)", configured: uploadPostKeyConfigured(), required: true,
      source: src("UPLOAD_POST_API_KEY"), secret: "UPLOAD_POST_API_KEY",
      unlocks: "Conexão do TikTok de cada cliente pelo portal e publicação de vídeo e de post de foto, com as opções do criativo, andamento e erros.",
      without: "Os posts de TikTok ficam na fila, aguardando a conexão. O Instagram segue normal.",
      where: "Cole aqui a chave criada em app.upload-post.com, em API Keys. Também vale como segredo UPLOAD_POST_API_KEY na função.",
      format: "Chave de API do Upload-Post",
      note: "O plano precisa incluir a integração white-label (conexão pelo nosso portal). Ver docs/TIKTOK.md.",
    },
    {
      id: "claude", name: "Claude (texto do agente e chat)", configured: claudeConfigured(), required: false,
      source: src("ANTHROPIC_API_KEY"), secret: "ANTHROPIC_API_KEY",
      unlocks: "O agente escreve sozinho o plano, o roteiro e a copy de cada post, e o chat de diagnóstico responde em linguagem natural.",
      without: "O agente usa o banco de pautas (textos prontos carregados no painel) e o chat responde por regras fixas.",
      where: "Cole aqui a chave criada em console.anthropic.com, em API Keys. Também vale como segredo ANTHROPIC_API_KEY na função.",
      format: "Começa com sk-ant-",
      note: `Modelo em uso: ${claudeModel()}. O uso é cobrado pela Anthropic por volume de texto.`,
    },
    {
      id: "midia", name: "Gerador de imagem (arte por template)", configured: true, required: true,
      source: "embutido na plataforma", secret: null,
      unlocks: "Imagem, carrossel e story em imagem montados a partir do texto do post e das cores da marca, sem chave externa.",
      without: "",
      where: "Nada a configurar. As cores e a assinatura de cada agente ficam na configuração do agente.",
      format: null,
      note: "Não produz vídeo. Reel precisa de vídeo enviado pelo time ou de um gerador de vídeo.",
    },
    {
      id: "higgsfield", name: "Gerador de imagem e vídeo por IA (Higgsfield, opcional)", configured: higgsfieldConfigured(), required: false,
      source: src("HIGGSFIELD_API_KEY"), secret: "HIGGSFIELD_API_KEY",
      unlocks: "Imagem e vídeo gerados por IA, inclusive Reel, sem o time enviar mídia.",
      without: "Imagem e carrossel saem pela arte por template. Reel depende de vídeo enviado pelo time.",
      where: "Cole aqui o par da chave da API do Higgsfield. Também vale como segredo HIGGSFIELD_API_KEY na função.",
      format: "id:segredo (ID da chave, dois-pontos, segredo)",
      note: "A VERIFICAR: adaptador escrito pela documentação pública, ainda não testado com chave real. O pacote atual do agente não cita o Higgsfield.",
    },
  ];
}

type TestResult = { ok: boolean; message: string; detail?: unknown };

async function testInstagram(): Promise<TestResult> {
  const appId = Deno.env.get("IG_APP_ID"), appSecret = Deno.env.get("IG_APP_SECRET");
  if (!appId || !appSecret) return { ok: false, message: "IG_APP_ID e IG_APP_SECRET não estão nos segredos da função." };
  const version = Deno.env.get("IG_API_VERSION") ?? "v27.0";
  const res = await fetch(`https://graph.facebook.com/${version}/${appId}?fields=id,name&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.error) return { ok: false, message: `A Meta recusou as credenciais do app: ${body?.error?.message ?? "HTTP " + res.status}` };
  const { count } = await db.from("social_accounts").select("id", { count: "exact", head: true }).eq("platform", "instagram").eq("status", "connected").eq("simulated", false);
  return { ok: true, message: `App "${body.name}" reconhecido pela Meta. ${count ?? 0} conta(s) de Instagram conectada(s).` };
}

async function testTikTok(): Promise<TestResult> {
  const key = secret("UPLOAD_POST_API_KEY");
  if (!key) return { ok: false, message: "A chave do Upload-Post ainda não foi informada." };
  const base = (Deno.env.get("UPLOAD_POST_BASE_URL") ?? "https://api.upload-post.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/api/uploadposts/users`, { headers: { authorization: `Apikey ${key}` }, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) return { ok: false, message: `O Upload-Post recusou a chave (HTTP ${res.status}).` };
  if (!res.ok || body?.success === false) return { ok: false, message: `O Upload-Post respondeu com erro: ${body?.message ?? body?.error ?? "HTTP " + res.status}` };
  const profiles = Array.isArray(body?.profiles) ? body.profiles.length : 0;
  const limit = body?.limit ?? body?.plan ?? null;
  return { ok: true, message: `Chave aceita pelo Upload-Post. ${profiles} perfil(is) criado(s) na conta.`, detail: limit ? { limite: limit } : undefined };
}

async function testClaude(): Promise<TestResult> {
  const key = secret("ANTHROPIC_API_KEY");
  if (!key) return { ok: false, message: "A chave do Claude ainda não foi informada." };
  const model = claudeModel();
  try {
    const client = new Anthropic({ apiKey: key, timeout: 20_000, maxRetries: 0 });
    const m = await client.models.retrieve(model);
    return { ok: true, message: `Chave aceita pela Anthropic. Modelo ${m.display_name ?? m.id} disponível.` };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, message: "A Anthropic recusou a chave (inválida ou revogada)." };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, message: "A chave não tem permissão para usar a API." };
    if (e instanceof Anthropic.NotFoundError) return { ok: false, message: `A chave é válida, mas o modelo ${model} não está disponível nesta conta.` };
    if (e instanceof Anthropic.APIConnectionError) return { ok: false, message: "Não foi possível falar com a Anthropic agora. Tente de novo." };
    return { ok: false, message: `A Anthropic respondeu com erro: ${e instanceof Error ? e.message.slice(0, 200) : "desconhecido"}` };
  }
}

// Consulta um pedido que nao existe: chave errada responde 401, chave certa responde 404. Nao gasta credito.
async function testHiggsfield(): Promise<TestResult> {
  const key = secret("HIGGSFIELD_API_KEY");
  if (!key) return { ok: false, message: "A chave do Higgsfield ainda não foi informada (opcional)." };
  if (!higgsfieldConfigured()) return { ok: false, message: "A chave precisa estar no formato id:segredo." };
  const base = (Deno.env.get("HIGGSFIELD_BASE_URL") ?? "https://api.higgsfield.ai").replace(/\/+$/, "");
  const res = await fetch(`${base}/requests/${crypto.randomUUID()}/status`, { headers: { authorization: `Key ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403) return { ok: false, message: `O Higgsfield recusou a chave (HTTP ${res.status}).` };
  if (res.status === 404 || res.ok) return { ok: true, message: "Chave aceita pelo Higgsfield. A geração em si ainda não foi testada (A VERIFICAR no primeiro uso)." };
  return { ok: false, message: `O Higgsfield respondeu HTTP ${res.status}. Não foi possível confirmar a chave.` };
}

const TESTS: Record<string, () => Promise<TestResult>> = {
  instagram: testInstagram, tiktok: testTikTok, claude: testClaude, higgsfield: testHiggsfield,
  midia: () => templatePing(),
};

// seg sem o prefixo /admin: ["integrations"], ["integrations", ID, "test"], ["integrations", NOME_DO_SEGREDO].
export async function keyRoutes(req: Request, seg: string[]): Promise<Response | null> {
  const m = req.method;
  if (seg[0] !== "integrations") return null;
  if (m === "GET" && seg.length === 1) return json({ items: await items() });
  if (m === "POST" && seg[2] === "test" && TESTS[seg[1]]) {
    const t0 = Date.now();
    let result: TestResult;
    try { result = await TESTS[seg[1]](); }
    catch (e) { result = { ok: false, message: e instanceof Error && e.name === "TimeoutError" ? "O fornecedor não respondeu a tempo." : `Falha no teste: ${e instanceof Error ? e.message.slice(0, 200) : "erro"}` }; }
    return json({ ...result, ms: Date.now() - t0 });
  }
  const name = seg[1] ?? "";
  if (!(PANEL_SECRETS as readonly string[]).includes(name)) return null;
  if (m === "POST" && seg.length === 2) {
    const b = await readJson(req);
    const value = str(b.value, 600);
    if (value.length < 10 || /\s/.test(value)) throw new HttpError(400, "bad_value", "Cole a chave completa, sem espaços.");
    if (name === "HIGGSFIELD_API_KEY" && !/^[^\s:]+:\S+$/.test(value)) throw new HttpError(400, "bad_value", "A chave do Higgsfield deve estar no formato id:segredo.");
    must(await db.rpc("panel_secret_set", { p_name: name, p_value: value }));
    await loadSecrets(true);
    return json({ ok: true, items: await items() });
  }
  if (m === "DELETE" && seg.length === 2) {
    must(await db.rpc("panel_secret_clear", { p_name: name }));
    await loadSecrets(true);
    return json({ ok: true, items: await items() });
  }
  return null;
}
