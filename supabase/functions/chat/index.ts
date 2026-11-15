// Sr. Post: chat de diagnostico do time (somente leitura). Funcao propria para nao pesar na "api".
// Rotas (x-admin-key): POST /admin/chat e GET /admin/chat/history.
// O codigo fica em ../api/lib e e empacotado com esbuild na publicacao (ver docs/ESTADO.md).
import { authKey, CORS, HttpError, json } from "../api/lib/core.ts";
import { loadSecrets } from "../api/lib/secrets.ts";
import { chatRoutes } from "../api/lib/chat.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*?\/chat(?=\/|$)/, "") || "/";
  try {
    await loadSecrets();
    if (path === "/health") return json({ ok: true, function: "chat" });
    if (/^\/admin\/chat(\/|$)/.test(path)) {
      await authKey(req, ["admin"]);
      const res = await chatRoutes(req, path.slice(7).split("/").filter(Boolean));
      if (res) return res;
    }
    throw new HttpError(404, "not_found", "Rota não encontrada.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error("unhandled", path, e);
    return json({ error: "internal", message: "Erro interno. Tente de novo em instantes." }, 500);
  }
});
