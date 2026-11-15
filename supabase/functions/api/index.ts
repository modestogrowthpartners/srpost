// Sr. Post: API unica do portal. Rotas:
//   /portal/*     cliente (link magico em x-portal-token)
//   /admin/*      time (x-admin-key)
//   /ingest/*     automacoes (x-api-key)
//   /instagram/*  retorno do OAuth e callbacks da Meta
//   /connect/*    retorno da conexao por provedor (TikTok)
//   /worker/tick  publicacao e metricas (pg_cron)
//   O motor dos agentes, a central e o chat de diagnostico ficam nas funcoes "agents" e "chat".
import { authKey, CORS, getSetting, HttpError, igConfigured, json } from "./lib/core.ts";
import { portalRoutes } from "./lib/portal.ts";
import { adminRoutes, ingestRoutes } from "./lib/admin.ts";
import { instagramRoutes } from "./lib/igroutes.ts";
import { runWorker } from "./lib/worker.ts";
import { connectReturn } from "./lib/connect.ts";
import { uploadPostConfigured } from "./lib/uploadpost.ts";
import { loadSecrets, providerStatus } from "./lib/secrets.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*?\/api(?=\/|$)/, "") || "/";
  try {
    await loadSecrets();
    if (path === "/health") return json({ ok: true, ig_configured: igConfigured(), tiktok_configured: uploadPostConfigured(), generators: providerStatus() });
    if (req.method === "GET" && path.startsWith("/connect/return/")) return await connectReturn(req, path.slice(16));
    if (path.startsWith("/portal/")) return await portalRoutes(req, path.slice(7));
    if (path.startsWith("/admin/")) return await adminRoutes(req, path.slice(6));
    if (path.startsWith("/ingest/")) return await ingestRoutes(req, path.slice(7));
    if (path.startsWith("/instagram/")) return await instagramRoutes(req, path.slice(10));
    if (path === "/worker/tick" && req.method === "POST") {
      const secret = req.headers.get("x-worker-secret") ?? "";
      const expected = await getSetting("worker_secret");
      if (!expected || secret !== expected) await authKey(req, ["admin"]);
      return json(await runWorker());
    }
    throw new HttpError(404, "not_found", "Rota não encontrada.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error("unhandled", path, e);
    return json({ error: "internal", message: "Erro interno. Tente de novo em instantes." }, 500);
  }
});
