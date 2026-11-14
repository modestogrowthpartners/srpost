// Rotas publicas chamadas pela Meta: retorno do OAuth, desautorizacao e exclusao de dados.
import { db, FUNCTIONS_BASE, HttpError, json, must, portalUrl, redirect } from "./core.ts";
import { exchangeCode, IgError, me, parseSignedRequest } from "./instagram.ts";

async function back(params: Record<string, string>): Promise<Response> {
  const url = new URL(await portalUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return redirect(url.toString());
}

async function callback(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const { data: st } = await db.from("oauth_states").select("state, client_id, expires_at").eq("state", state).maybeSingle();
  if (st) await db.from("oauth_states").delete().eq("state", state);
  if (!st || new Date(st.expires_at) < new Date()) return back({ ig: "erro", motivo: "expirado" });
  if (q.get("error")) return back({ ig: "erro", motivo: q.get("error") === "access_denied" ? "negado" : "instagram" });

  const code = (q.get("code") ?? "").replace(/#_$/, "");
  const appId = Deno.env.get("IG_APP_ID");
  const secret = Deno.env.get("IG_APP_SECRET");
  if (!code || !appId || !secret) return back({ ig: "erro", motivo: "configuracao" });

  try {
    const tok = await exchangeCode(appId, secret, `${FUNCTIONS_BASE}/instagram/callback`, code);
    const profile = await me(tok.token);
    const now = new Date();
    const row = {
      client_id: st.client_id, platform: "instagram",
      external_id: String(profile.user_id ?? profile.id),
      username: profile.username ?? null, name: profile.name ?? null,
      profile_picture_url: profile.profile_picture_url ?? null,
      account_type: profile.account_type ?? null,
      followers_count: typeof profile.followers_count === "number" ? profile.followers_count : null,
      scopes: tok.permissions, status: "connected", last_error: null,
      token_issued_at: now.toISOString(),
      token_expires_at: new Date(now.getTime() + tok.expiresIn * 1000).toISOString(),
      connected_at: now.toISOString(), updated_at: now.toISOString(),
    };
    const acc = must(await db.from("social_accounts").upsert(row, { onConflict: "client_id,platform" }).select("id").single()) as { id: string };
    must(await db.rpc("ig_token_store", { p_account_id: acc.id, p_token: tok.token }));
    await db.from("posts").update({ social_account_id: acc.id })
      .eq("client_id", st.client_id).in("status", ["scheduled", "failed"]);
    return back({ ig: "ok" });
  } catch (e) {
    console.error("ig callback", e);
    return back({ ig: "erro", motivo: e instanceof IgError ? "instagram" : "interno" });
  }
}

async function signedPayload(req: Request): Promise<Record<string, unknown>> {
  const secret = Deno.env.get("IG_APP_SECRET");
  if (!secret) throw new HttpError(503, "ig_not_configured");
  const form = await req.formData().catch(() => null);
  const signed = String(form?.get("signed_request") ?? "");
  const payload = await parseSignedRequest(signed, secret);
  if (!payload) throw new HttpError(400, "bad_signature", "signed_request inválido.");
  return payload;
}

async function removeAccounts(igUserId: string): Promise<number> {
  const { data: accs } = await db.from("social_accounts").select("id").eq("platform", "instagram").eq("external_id", igUserId);
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
  if (req.method === "POST" && path === "/data-deletion") {
    const p = await signedPayload(req);
    await removeAccounts(String(p.user_id ?? ""));
    const code = crypto.randomUUID();
    const url = new URL(await portalUrl());
    url.searchParams.set("exclusao", code);
    return json({ url: url.toString(), confirmation_code: code });
  }
  throw new HttpError(404, "not_found", "Rota não encontrada.");
}
