// Banco de pautas: posts ja escritos (plano, roteiro e copy) que o agente consome um por vez, sem repetir.
// E o modo que funciona sem chave de modelo de linguagem, igual ao arquivo de copies do pacote anterior.
// Com a chave do Claude, o agente escreve sozinho e o banco vira opcional.
import { db, HttpError, isUuid, json, must, readJson, str } from "./core.ts";
import { AgentProfile, Copy, FORMATOS, Formato, GenConfigError, GenContext, Generated, PlanItem, Script, TextGenerator } from "./gentypes.ts";
import { existingThemes, repeated } from "./profile.ts";

// deno-lint-ignore no-explicit-any
type Row = any;
const usage = { provider: "banco", model: null, input_tokens: null, output_tokens: null };

async function itemOfRun(runId: string | undefined): Promise<Row> {
  if (!runId) throw new GenConfigError("O banco de pautas precisa saber qual execução está pedindo o texto.", "banco_sem_execucao");
  const { data } = await db.from("content_bank").select("*").eq("used_run_id", runId).maybeSingle();
  if (!data) throw new Error("A pauta desta execução não foi encontrada no banco.");
  return data;
}

// O banco entrega texto pronto: nao consegue aplicar um pedido de ajuste do cliente.
function noRewrite(ctx: GenContext) {
  if (ctx.revision > 0 || ctx.feedback) {
    throw new GenConfigError("O cliente pediu ajuste e este agente usa o banco de pautas, que não reescreve texto. Edite a pauta no painel ou configure a chave do Claude.", "banco_nao_reescreve");
  }
}

export function bankGenerator(profile: AgentProfile): TextGenerator {
  return {
    provider: "banco",
    async plan(_p: AgentProfile, ctx: GenContext): Promise<Generated<PlanItem>> {
      noRewrite(ctx);
      const existing = await existingThemes(profile.client_id);
      // Prefere uma pauta do formato da vez; se nao houver, usa a proxima de qualquer formato do agente.
      for (let guard = 0; guard < 20; guard++) {
        const base = () => db.from("content_bank").select("*").eq("client_id", profile.client_id).eq("status", "disponivel").order("position").order("created_at").limit(1);
        let { data } = await base().eq("formato", ctx.formato);
        if (!data?.length) ({ data } = await base().in("formato", profile.formats));
        const item = data?.[0];
        if (!item) {
          throw new GenConfigError("O banco de pautas deste agente acabou. Adicione pautas no painel ou configure a chave do Claude para o agente escrever sozinho.", "banco_vazio");
        }
        const dup = repeated(item.tema, existing);
        if (dup) {
          await db.from("content_bank").update({ status: "repetido", note: `Tema parecido com o que o perfil já tem: ${dup}`.slice(0, 300) }).eq("id", item.id).eq("status", "disponivel");
          continue;
        }
        // Marca como usada so se ainda estiver disponivel: duas execucoes nunca pegam a mesma pauta.
        const taken = must(await db.from("content_bank").update({ status: "usado", used_run_id: ctx.run_id ?? null, used_at: new Date().toISOString() })
          .eq("id", item.id).eq("status", "disponivel").select("id")) as Row[];
        if (!taken?.length) continue;
        return { value: { ...(item.plan as PlanItem), tema: item.tema, pilar: item.pilar ?? (item.plan?.pilar ?? ""), formato: item.formato as Formato }, usage };
      }
      throw new GenConfigError("Todas as pautas disponíveis repetem temas que o perfil já tem. Adicione pautas novas.", "banco_repetido");
    },
    async script(_p: AgentProfile, _plan: PlanItem, ctx: GenContext): Promise<Generated<Script>> {
      noRewrite(ctx);
      return { value: (await itemOfRun(ctx.run_id)).script as Script, usage };
    },
    async copy(_p: AgentProfile, _plan: PlanItem, _script: Script, ctx: GenContext): Promise<Generated<Copy>> {
      noRewrite(ctx);
      return { value: (await itemOfRun(ctx.run_id)).copy as Copy, usage };
    },
  };
}

// ---------- Rotas do painel ----------
const text = (v: unknown, max: number) => str(v, max).replace(/\s*[—–]\s*/g, ", ");
const slideList = (v: unknown) => (Array.isArray(v) ? v : []).map((s) => ({ titulo: text((s as Row)?.titulo, 140), texto: str((s as Row)?.texto, 400).replace(/\s*[—–]\s*/g, ", ") })).filter((s) => s.titulo);

// Valida uma pauta enviada pelo painel e monta plano, roteiro e copy no formato que o motor usa.
function parseItem(raw: Row, i: number) {
  const label = `Pauta ${i + 1}`;
  const formato = str(raw?.formato, 12) as Formato;
  if (!(FORMATOS as string[]).includes(formato)) throw new HttpError(400, "bad_format", `${label}: formato deve ser reel, carrossel, imagem ou story.`);
  const tema = text(raw?.tema, 160);
  if (tema.length < 6) throw new HttpError(400, "bad_theme", `${label}: informe o tema.`);
  const slides = slideList(raw?.slides);
  if (formato === "carrossel" && (slides.length < 2 || slides.length > 10)) throw new HttpError(400, "bad_slides", `${label}: carrossel precisa de 2 a 10 slides.`);
  if ((formato === "imagem" || formato === "story") && slides.length !== 1) throw new HttpError(400, "bad_slides", `${label}: ${formato} precisa de exatamente 1 item em slides (título e texto da arte).`);
  const legenda = str(raw?.legenda, 2200).replace(/\s*—\s*/g, ", ");
  if (formato !== "story" && legenda.length < 10) throw new HttpError(400, "bad_caption", `${label}: informe a legenda.`);
  const hashtags = str(raw?.hashtags, 600);
  if ((hashtags.match(/#/g) ?? []).length > 30) throw new HttpError(400, "too_many_hashtags", `${label}: no máximo 30 hashtags.`);
  const hook = text(raw?.hook, 200) || slides[0]?.titulo || tema;
  const beats = (Array.isArray(raw?.beats) ? raw.beats : []).map((b: Row) => ({ tempo: str(b?.tempo, 20), fala: text(b?.fala, 400), tela: text(b?.tela, 120) })).filter((b: Row) => b.fala || b.tela);
  if (formato === "reel" && !beats.length) throw new HttpError(400, "bad_beats", `${label}: Reel precisa do roteiro em beats (tempo, fala, tela).`);
  return {
    formato, tema, pilar: text(raw?.pilar, 60) || null,
    plan: { tema, pilar: text(raw?.pilar, 60), objetivo: text(raw?.objetivo, 200), angulo: text(raw?.angulo, 300) },
    script: { hooks: [{ texto: hook, formula: "banco de pautas", nota: 0 }], hook, beats, slides, conceito_visual: text(raw?.conceito_visual, 400), duracao_s: typeof raw?.duracao_s === "number" ? raw.duracao_s : null },
    copy: { titulo: text(raw?.titulo, 120) || tema.slice(0, 120), legenda: formato === "story" ? "" : legenda, hashtags: formato === "story" ? "" : hashtags, alertas: [] },
  };
}

async function listBank(clientId: string) {
  const rows = must(await db.from("content_bank").select("id, status, formato, tema, pilar, note, used_at, used_run_id, position, created_at, titulo:copy->>titulo, legenda:copy->>legenda, script")
    .eq("client_id", clientId).order("status").order("position").order("created_at").limit(300)) ?? [];
  const counts: Record<string, number> = { disponivel: 0, usado: 0, repetido: 0 };
  for (const r of rows as Row[]) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return json({
    counts,
    items: (rows as Row[]).map((r) => ({ id: r.id, status: r.status, formato: r.formato, tema: r.tema, pilar: r.pilar, note: r.note, used_at: r.used_at, used_run_id: r.used_run_id, created_at: r.created_at,
      titulo: r.titulo, legenda: r.legenda, slides: r.script?.slides ?? [], hook: r.script?.hook ?? null })),
  });
}

// Adiciona pautas. Tema repetido (no proprio banco ou no que o perfil ja tem) fica de fora, com o motivo.
async function addBank(clientId: string, req: Request) {
  const { data: c } = await db.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!c) throw new HttpError(404, "not_found", "Cliente não encontrado.");
  const b = await readJson(req);
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length || raw.length > 60) throw new HttpError(400, "bad_items", "Envie de 1 a 60 pautas em items.");
  const parsed = raw.map(parseItem);
  const { data: have } = await db.from("content_bank").select("tema").eq("client_id", clientId).in("status", ["disponivel", "usado"]);
  const existing = [...(have ?? []).map((h: Row) => h.tema), ...await existingThemes(clientId)];
  const { data: last } = await db.from("content_bank").select("position").eq("client_id", clientId).order("position", { ascending: false }).limit(1);
  let pos = (last?.[0]?.position ?? 0) + 1;
  const rows: Row[] = [], skipped: { tema: string; reason: string }[] = [];
  for (const it of parsed) {
    const dup = repeated(it.tema, [...existing, ...rows.map((r) => r.tema)]);
    if (dup) { skipped.push({ tema: it.tema, reason: `Tema parecido com um que já existe: ${dup}` }); continue; }
    rows.push({ client_id: clientId, ...it, position: pos++ });
  }
  const created = rows.length ? must(await db.from("content_bank").insert(rows).select("id, tema, formato")) : [];
  return json({ created, skipped }, 201);
}

async function removeBank(id: string) {
  const rows = must(await db.from("content_bank").delete().eq("id", id).in("status", ["disponivel", "repetido"]).select("id")) as Row[];
  if (!rows?.length) throw new HttpError(409, "not_removable", "Só pautas ainda não usadas podem ser removidas.");
  return json({ ok: true });
}

// seg sem o prefixo /admin: ["agents", clientId, "bank"] ou ["bank", id].
export async function bankRoutes(req: Request, seg: string[]): Promise<Response | null> {
  const m = req.method;
  if (seg[0] === "agents" && isUuid(seg[1]) && seg[2] === "bank") {
    if (m === "GET") return listBank(seg[1]);
    if (m === "POST") return addBank(seg[1], req);
  }
  if (seg[0] === "bank" && isUuid(seg[1]) && m === "DELETE") return removeBank(seg[1]);
  return null;
}
