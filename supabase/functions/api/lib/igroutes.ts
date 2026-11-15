// Rotas publicas chamadas pela Meta: retorno do OAuth, desautorizacao e exclusao de dados.
import { backToPortal as back, db, FUNCTIONS_BASE, HttpError, json, must, portalUrl } from "./core.ts";
import * as ig from "./instagram.ts";

// Guarda o ultimo erro de conexao para aparecer no painel do time (Configuracao).
async function note(reason: string, detail: string) {
  console.error("ig oauth", reason, detail);
  await db.from("settings").upsert({ key: "ig_last_oauth_error", value: JSON.stringify({ at: new Date().toISOString(), reason, detail: detail.slice(0, 500) }) });
}

async function callback(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const { data: st } = await db.from("oauth_states").select("state, client_id, expires_at").eq("state", state).maybeSingle();
  if (st) await db.from("oauth_states").delete().eq("state", state);
  if (!st || new Date(st.expires_at) < new Date()) return back({ ig: "erro", motivo: "expirado" });
  if (q.get("error")) {
    const denied = q.get("error") === "access_denied";
    if (!denied) await note("dialog", `${q.get("error")}: ${q.get("error_description") ?? ""}`);
    return back({ ig: "erro", motivo: denied ? "negado" : "instagram" });
  }

  const code = q.get("code") ?? "";
  const appId = Deno.env.get("IG_APP_ID");
  const secret = Deno.env.get("IG_APP_SECRET");
  if (!code || !appId || !secret) return back({ ig: "erro", motivo: "configuracao" });

  try {
    const tok = await ig.exchangeCode(appId, secret, `${FUNCTIONS_BASE}/instagram/callback`, code);
    const perms = await ig.grantedPermissions(tok.token);
    if (perms) {
      const missing = ig.REQUIRED_PERMISSIONS.filter((p) => !perms.includes(p));
      if (missing.length) {
        await note("permissoes", `Faltam: ${missing.join(", ")}. Concedidas: ${perms.join(", ")}`);
        return back({ ig: "erro", motivo: "permissoes" });
      }
    }
    const { accounts, trace } = await ig.listInstagramAccounts(tok.token);
    if (!accounts.length) {
      await note("sem_conta", `Nenhuma conta profissional do Instagram veio no login. Consultas: ${trace}`);
      return back({ ig: "erro", motivo: "sem_conta" });
    }
    // Em reconexao, mantem a mesma conta; senao usa a primeira liberada.
    const { data: prev } = await db.from("social_accounts").select("external_id").eq("client_id", st.client_id).eq("platform", "instagram").maybeSingle();
    const chosen = accounts.find((a) => a.igId === prev?.external_id) ?? accounts[0];
    // Com Pagina, publica com o token da Pagina. Sem Pagina (conta concedida direto pelo portfolio empresarial),
    // publica pelo ID da conta do Instagram com o proprio token recebido no login.
    const token = chosen.pageToken ?? tok.token;
    // Token de Pagina derivado de token duravel nao expira; caso contrario vale o prazo do token de origem.
    const expiresAt = chosen.pageToken && tok.durable ? null
      : tok.expiresIn ? new Date(Date.now() + tok.expiresIn * 1000).toISOString() : null;
    await db.from("settings").delete().eq("key", "ig_last_oauth_error");
    if (!tok.durable) await note("token_curto", "O token recebido é de curta duração. Confira o tipo de token da configuração de login.");

    const now = new Date().toISOString();
    const row = {
      client_id: st.client_id, platform: "instagram", provider: "meta", provider_ref: null, external_id: chosen.igId,
      username: chosen.username, name: chosen.name, profile_picture_url: chosen.picture,
      account_type: null, followers_count: chosen.followers,
      scopes: perms ?? [], status: "connected", last_error: null,
      fb_user_id: await ig.fbUserId(tok.token), page_id: chosen.pageId, page_name: chosen.pageName,
      token_issued_at: now, token_expires_at: expiresAt, connected_at: now, updated_at: now,
    };
    const acc = must(await db.from("social_accounts").upsert(row, { onConflict: "client_id,platform" }).select("id").single()) as { id: string };
    must(await db.rpc("ig_token_store", { p_account_id: acc.id, p_token: token }));
    await db.from("posts").update({ social_account_id: acc.id })
      .eq("client_id", st.client_id).eq("platform", "instagram").in("status", ["scheduled", "failed"]);
    // Reconexao: os posts que ficaram parados voltam para a fila, redistribuidos para nao sairem todos de uma vez.
    const { data: moved } = await db.rpc("respread_overdue", { p_client_id: st.client_id, p_platform: "instagram" });
    const params: Record<string, string> = { ig: "ok" };
    if (accounts.length > 1) params.contas = String(accounts.length);
    if (typeof moved === "number" && moved > 0) params.atrasados = String(moved);
    return back(params);
  } catch (e) {
    await note("excecao", e instanceof Error ? e.message : String(e));
    return back({ ig: "erro", motivo: e instanceof ig.IgError ? "instagram" : "interno" });
  }
}

async function signedPayload(req: Request): Promise<Record<string, unknown>> {
  const secret = Deno.env.get("IG_APP_SECRET");
  if (!secret) throw new HttpError(503, "ig_not_configured");
  const form = await req.formData().catch(() => null);
  const signed = String(form?.get("signed_request") ?? "");
  const payload = await ig.parseSignedRequest(signed, secret);
  if (!payload) throw new HttpError(400, "bad_signature", "signed_request inválido.");
  return payload;
}

// O user_id do signed_request e o ID do usuario do Facebook no app (login unificado).
async function removeAccounts(userId: string): Promise<number> {
  if (!userId) return 0;
  const { data: accs } = await db.from("social_accounts").select("id").eq("platform", "instagram")
    .or(`fb_user_id.eq.${userId.replace(/[^0-9A-Za-z_-]/g, "")},external_id.eq.${userId.replace(/[^0-9A-Za-z_-]/g, "")}`);
  for (const a of accs ?? []) {
    await db.rpc("ig_token_delete", { p_account_id: a.id });
    await db.from("social_accounts").delete().eq("id", a.id);
  }
  return accs?.length ?? 0;
}

export async function instagramRoutes(req: Request, path: string): Promise<Response> {
  if (req.method === "GET" && path === "/callback") return callback(req);
  if (req.method === "POST" && path === "/deauthorize") {
    const p = await signedPayload(req);
    await removeAccounts(String(p.user_id ?? ""));
    return json({ ok: true });
  }
  // Callback de exclusao de dados da Meta: apaga a conexao e os tokens e devolve um codigo de acompanhamento.
  if (req.method === "POST" && path === "/data-deletion") {
    const p = await signedPayload(req);
    const removed = await removeAccounts(String(p.user_id ?? ""));
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    must(await db.from("deletion_requests").insert({ code, platform: "meta", accounts_removed: removed, completed_at: new Date().toISOString() }));
    const url = new URL("exclusao-de-dados.html", await portalUrl());
    url.searchParams.set("codigo", code);
    return json({ url: url.toString(), confirmation_code: code });
  }
  // Consulta publica do andamento de um pedido de exclusao (usada pela pagina exclusao-de-dados.html).
  if (req.method === "GET" && path === "/deletion-status") {
    const code = (new URL(req.url).searchParams.get("code") ?? "").replace(/[^0-9a-f]/gi, "").slice(0, 32);
    const { data } = await db.from("deletion_requests").select("created_at, completed_at").eq("code", code).maybeSingle();
    return json(data ? { found: true, received_at: data.created_at, completed_at: data.completed_at } : { found: false });
  }
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}
