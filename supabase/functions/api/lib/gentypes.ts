// Contrato da geracao de conteudo. O motor dos agentes (agents.ts) so conhece estas interfaces:
// trocar o fornecedor de texto ou de midia e criar outra implementacao em generators.ts, sem tocar no motor.

export type Formato = "reel" | "carrossel" | "imagem" | "story";
export const FORMATOS: Formato[] = ["reel", "carrossel", "imagem", "story"];

// Perfil que o agente usa para escrever: vem das tabelas clients e agents.
export type AgentProfile = {
  client_id: string; client_name: string; segment: string | null; timezone: string; is_demo: boolean;
  agent_name: string; context: string; audience: string; tone: string;
  pillars: string[]; formats: Formato[]; platforms: string[];
  // Voz da marca. Todos opcionais: palavras que usa, palavras proibidas, chamada para acao,
  // provas e numeros que pode citar, temas proibidos, uso de emoji.
  voice: { usa?: string; evita?: string; cta?: string; provas?: string; proibido?: string; emoji?: string };
  default_link: string | null; ai_label: boolean; story_default: boolean;
};

export type GenContext = {
  slot_at: string | null;          // horario do post (ISO) ou null quando o time mandou rodar agora
  formato: Formato;                // formato escolhido pelo motor para este post
  pilar: string | null;            // pilar sugerido pelo motor (rodizio); o gerador pode ajustar o angulo
  recentes: string[];              // titulos dos ultimos posts, para nao repetir tema
  feedback: string | null;         // pedido de ajuste do cliente, quando e uma nova versao
  revision: number;
};

export type PlanItem = { tema: string; pilar: string; objetivo: string; angulo: string };

export type Script = {
  hooks: { texto: string; formula: string; nota: number }[]; // opcoes de abertura, com nota de 0 a 100
  hook: string;                                              // abertura escolhida
  beats: { tempo: string; fala: string; tela: string }[];    // reel e story em video: fala e texto de tela por trecho
  slides: { titulo: string; texto: string }[];               // carrossel: um item por slide
  conceito_visual: string;                                   // o que a imagem ou o video mostra
  duracao_s: number | null;
};

export type Copy = {
  titulo: string;      // titulo interno do criativo (aparece no cartao do cliente)
  legenda: string;     // sem hashtags e sem link
  hashtags: string;    // ate 30, separadas por espaco
  alertas: string[];   // avisos do revisor de texto (ex.: frase com cara de IA trocada, promessa removida)
};

// Uso de tokens e custo estimado de uma chamada, quando o fornecedor informa.
export type GenUsage = { provider: string; model: string | null; input_tokens: number | null; output_tokens: number | null };
export type Generated<T> = { value: T; usage: GenUsage };

export interface TextGenerator {
  readonly provider: string;
  plan(profile: AgentProfile, ctx: GenContext): Promise<Generated<PlanItem>>;
  script(profile: AgentProfile, plan: PlanItem, ctx: GenContext): Promise<Generated<Script>>;
  copy(profile: AgentProfile, plan: PlanItem, script: Script, ctx: GenContext): Promise<Generated<Copy>>;
}

// Pedido de midia. O motor monta a partir do roteiro.
export type MediaRequest = {
  formato: Formato;
  proporcao: "4:5" | "9:16";
  prompt: string;            // descricao visual principal
  slides: string[];          // carrossel: uma descricao por imagem (vazio nos demais formatos)
  texto_na_arte: string[];   // textos que devem aparecer na arte (titulo do slide, texto de tela)
  duracao_s: number | null;  // video
  briefing: string;          // resumo legivel para quem vai produzir a midia a mao
};

export type MediaItem = { kind: "image" | "video"; url: string; thumb: string | null };

// "pending" pode trazer uma nova referencia: e assim que um fornecedor encadeia etapas sem esperar
// (ex.: gera a imagem, depois usa a imagem para gerar o video). O motor guarda a referencia nova.
export type MediaPoll =
  | { state: "pending"; note: string | null; ref?: string }
  | { state: "ready"; items: MediaItem[] }
  | { state: "failed"; error: string };

export interface MediaGenerator {
  readonly provider: string;
  // manual = o time envia a midia pelo painel; async = o fornecedor gera e o motor consulta a cada ciclo.
  readonly mode: "manual" | "async";
  /** Inicia a geracao e devolve a referencia do job. Nunca espera o resultado. */
  start(req: MediaRequest, profile: AgentProfile): Promise<{ ref: string; note: string | null }>;
  /** Consulta o job. */
  poll(ref: string, profile: AgentProfile): Promise<MediaPoll>;
}

// Erro de configuracao (chave ausente, fornecedor desligado): nao adianta tentar de novo sozinho.
export class GenConfigError extends Error {
  constructor(message: string, public code: string) { super(message); }
}
