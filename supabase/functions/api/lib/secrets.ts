// Chaves dos fornecedores. Cada chave pode vir de dois lugares:
//   1. segredo da funcao no Supabase (variavel de ambiente), ou
//   2. valor colado no painel, guardado criptografado no Vault do projeto.
// O valor nunca volta para o painel: a API so informa se existe, de onde veio e o resultado do teste.
import { db } from "./core.ts";

export const PANEL_SECRETS = ["ANTHROPIC_API_KEY", "UPLOAD_POST_API_KEY", "HIGGSFIELD_API_KEY"] as const;
export type SecretName = typeof PANEL_SECRETS[number];
export const CLAUDE_MODEL_DEFAULT = "claude-opus-5-5";

let cache = new Map<string, string>();
let loadedAt = 0;

// Carrega as chaves coladas no painel. Chamado no inicio de cada requisicao; o cache dura 60 segundos,
// entao uma chave nova passa a valer em ate um minuto em todas as instancias.
export async function loadSecrets(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < 60_000) return;
  const { data, error } = await db.rpc("panel_secrets_read");
  if (error) { console.error("secrets", error.message); return; }
  cache = new Map(((data ?? []) as { name: string; value: string }[]).map((r) => [r.name, r.value]));
  loadedAt = Date.now();
}

export function secret(name: string): string {
  return (Deno.env.get(name) ?? "").trim() || (cache.get(name) ?? "").trim();
}

export function secretSource(name: string): "funcao" | "painel" | null {
  if ((Deno.env.get(name) ?? "").trim()) return "funcao";
  return (cache.get(name) ?? "").trim() ? "painel" : null;
}

export const claudeModel = () => (Deno.env.get("CLAUDE_MODEL") ?? "").trim() || CLAUDE_MODEL_DEFAULT;
export const claudeConfigured = () => secret("ANTHROPIC_API_KEY").length >= 10;
export const uploadPostKeyConfigured = () => secret("UPLOAD_POST_API_KEY").length > 10;
export const higgsfieldConfigured = () => /^[^\s:]+:\S+$/.test(secret("HIGGSFIELD_API_KEY"));

// O que cada fornecedor tem disponivel agora. Usado pela central, pelo chat e pelo /health.
export function providerStatus() {
  return {
    text: { claude: claudeConfigured(), banco: true as const, simulado: true as const },
    media: { template: true as const, manual: true as const, higgsfield: higgsfieldConfigured(), simulado: true as const },
    model: claudeModel(),
  };
}
