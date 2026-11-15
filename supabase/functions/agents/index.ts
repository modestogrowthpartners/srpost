// Sr. Post: funcao dos agentes. Separada da "api" para uma falha ou um ciclo lento de geracao nao afetar
// o portal nem a publicacao. Rotas (x-admin-key, exceto /tick):
//   /admin/agents...        central: lista, assistente Novo agente, configuracao, lote, rodar agora, ao vivo
//   /admin/runs...          execucao: detalhe, midia do time, cancelar, retomar
//   /admin/bank...          banco de pautas
//   /admin/integrations...  chaves e integracoes: estado, colar chave, testar
//   /tick                   motor dos agentes (pg_cron, x-worker-secret)
// O codigo fica em ../api/lib e e empacotado com esbuild na publicacao (ver docs/ESTADO.md).
import { authKey, CORS, getSetting, HttpError, json } from "../api/lib/core.ts";
import { loadSecrets, providerStatus } from "../api/lib/secrets.ts";
import { ENGINE_VERSION, runAgents } from "../api/lib/agents.ts";
import { agentRoutes } from "../api/lib/agentapi.ts";
import { keyRoutes } from "../api/lib/keys.ts";
import { bankRoutes } from "../api/lib/bank.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*?\/agents(?=\/|$)/, "") || "/";
  try {
    await loadSecrets();
    if (path === "/health") return json({ ok: true, function: "agents", version: ENGINE_VERSION, generators: providerStatus() });
    if (path === "/tick" && req.method === "POST") {
      const secret = req.headers.get("x-worker-secret") ?? "";
      const expected = await getSetting("worker_secret");
      if (!expected || secret !== expected) await authKey(req, ["admin"]);
      return json(await runAgents());
    }
    if (/^\/admin\/(agents|runs|integrations|bank)(\/|$)/.test(path)) {
      await authKey(req, ["admin"]);
      const seg = path.slice(7).split("/").filter(Boolean);
      const res = seg[0] === "integrations" ? await keyRoutes(req, seg)
        : (seg[0] === "bank" || seg[2] === "bank") ? await bankRoutes(req, seg)
        : await agentRoutes(req, seg);
      if (res) return res;
    }
    throw new HttpError(404, "not_found", "Rota não encontrada.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error("unhandled", path, e);
    return json({ error: "internal", message: "Erro interno. Tente de novo em instantes." }, 500);
  }
});
