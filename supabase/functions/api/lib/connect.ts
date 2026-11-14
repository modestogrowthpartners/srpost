// Conexao de contas por provedor (hoje: TikTok pelo Upload-Post). O cliente autoriza direto na rede;
// o Sr. Post nunca recebe senha nem token do TikTok.
import { backToPortal, ClientRow, db, FUNCTIONS_BASE, HttpError, json, must, randomToken } from "./core.ts";
import * as up from "./uploadpost.ts";

async function note(reason: string, detail: string) {
  console.error("tiktok connect", reason, detail);
  await db.from("settings").upsert({ key: "tiktok_last_connect_error", value: JSON.stringify({ at: new Date().toISOString(), reason, detail: detail.slice(0, 500) }) });
}

export async function tiktokStart(client: ClientRow): Promise<Response> {
  if (!up.uploadPostConfigured()) {
    throw new HttpError(503, "tiktok_not_configured", "A conexão com o TikTok ainda está sendo liberada pelo Sr. Post.");
  }
  const profile = up.profileName(client.id);
  try {
    await up.ensureProfile(profile, client.name);
    const state = randomToken(24);
    must(await db.from("oauth_states").insert({ state, client_id: client.id }));
    await db.from("oauth_states").delete().lt("expires_at", new Date().toISOString());
    const url = await up.startConnect("tiktok", profile, `${FUNCTIONS_BASE}/connect/return/${state}`);
    return json({ authorize_url: url });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    await note("start", e instanceof Error ? e.message : String(e));
    throw new HttpError(502, "tiktok_unavailable", "Não foi possível iniciar a conexão com o TikTok. Tente de novo em instantes.");
  }
}

// Retorno publico do provedor depois que o cliente autorizou (ou cancelou) no TikTok.
export async function connectReturn(req: Request, state: string): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const { data: st } = await db.from("oauth_states").select("state, client_id, expires_at").eq("state", state).maybeSingle();
  if (st) await db.from("oauth_states").delete().eq("state", state);
  if (!st) return backToPortal({ tt: "erro", motivo: "expirado" });
  const status = q.get("connect_status");
  if (status === "cancelled") return backToPortal({ tt: "erro", motivo: "negado" });
  if (status === "error") {
    await note("provider", `${q.get("error_code") ?? ""} ${q.get("error_description") ?? ""}`);
    return backToPortal({ tt: "erro", motivo: "tiktok" });
  }
  try {
    const profile = up.profileName(st.client_id);
    const acc = await up.connectedAccount(profile, "tiktok");
    if (!acc) return backToPortal({ tt: "erro", motivo: "sem_conta" });
    const now = new Date().toISOString();
    const row = must(await db.from("social_accounts").upsert({
      client_id: st.client_id, platform: "tiktok", provider: "uploadpost", provider_ref: profile,
      external_id: acc.handle ?? profile, username: acc.handle, name: acc.displayName, profile_picture_url: acc.image,
      status: "connected", last_error: null, token_secret_id: null, token_expires_at: null,
      connected_at: now, updated_at: now,
    }, { onConflict: "client_id,platform" }).select("id").single()) as { id: string };
    await db.from("posts").update({ social_account_id: row.id })
      .eq("client_id", st.client_id).eq("platform", "tiktok").in("status", ["scheduled", "failed"]);
    return backToPortal({ tt: "ok" });
  } catch (e) {
    await note("return", e instanceof Error ? e.message : String(e));
    return backToPortal({ tt: "erro", motivo: "interno" });
  }
}

export async function tiktokDisconnect(client: ClientRow): Promise<Response> {
  const { data: acc } = await db.from("social_accounts").select("id, provider_ref").eq("client_id", client.id).eq("platform", "tiktok").maybeSingle();
  if (acc) {
    if (acc.provider_ref && up.uploadPostConfigured()) {
      try { await up.disconnect(acc.provider_ref, "tiktok"); } catch (e) { await note("disconnect", e instanceof Error ? e.message : String(e)); }
    }
    must(await db.from("social_accounts").delete().eq("id", acc.id));
  }
  return json({ ok: true });
}
