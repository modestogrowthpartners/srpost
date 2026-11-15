# Central de agentes: arquitetura e plano

Objetivo: instalar e operar agentes direto pelo painel do Sr. Post, sem abrir código. Este documento registra a decisão de arquitetura, o desenho, o contrato entre as partes e o plano por fases, com o que foi testado de verdade em cada uma.

## 1. O que o pacote atual faz (lido antes de desenhar)

Fonte: `AGENTE_SOCIAL_MEDIA_V2 - ATUALIZADO.zip` e a transcrição do pedido do chat.

- A única automação que roda no pacote é `skills/tt-drive/worker.py`: observa uma pasta do Google Drive e sobe o que aparece para o TikTok pela Content Posting API. O resto são skills de escrita (plano, roteiro, legenda, humanização) usadas à mão.
- A instalação "Amanda" (GitHub Actions + Drive + Cloudinary + Buffer, um repositório por perfil) está só descrita em `INTEGRACAO_AMANDA_GITHUB.md`. O código dela (`publisher.py` do Buffer, `publish.yml`, `state.json`, `copies_amanda.json`) **não está no zip**. São 11 passos manuais e 5 segredos por perfil.
- **O pacote não gera mídia e não cita nenhum gerador.** A mídia chega pronta pelo Drive. A busca por Higgsfield, Runway, Kling, Veo, Sora, Midjourney e similares não encontrou nada (as ocorrências de "flux" são a palavra "fluxo"). Higgsfield como gerador fica **A VERIFICAR** com você.
- Não há chamada a modelo de linguagem no pacote. A etapa de legenda por IA aparece como "não construído".
- Regras do pacote que o novo sistema respeita: marcar conteúdo gerado por IA quando a rede aceita, nunca inventar número ou resultado, nunca repetir mídia, não automatizar comentário, curtida ou mensagem direta, e aprovação por item antes de publicar no TikTok.

## 2. Decisão: tudo no backend do Sr. Post, sem repositório por agente

Avaliei as duas opções pedidas.

| | A. Repositório + GitHub Actions por agente | B. Backend do Sr. Post com agendador próprio |
| --- | --- | --- |
| Instalar um agente novo | Criar o repositório a partir de um template (que ainda teria de ser escrito), gravar ao menos 5 segredos criptografados pela API, variáveis, ativar o workflow, semear o estado e validar | Gravar linhas no banco (cliente, agente, link do portal). Nenhum recurso externo |
| Segredos por agente | 5 hoje, mais as chaves de texto e de mídia | Nenhum. As chaves dos fornecedores são do projeto, cadastradas uma vez |
| Atualizar um agente | Commit de configuração no repositório dele | Salvar a configuração no painel |
| Atualizar todos | Um commit por repositório. Template não propaga mudança para repositórios já criados | Uma gravação em lote, ou um deploy da função (o código é o mesmo para todos) |
| Visão ao vivo e chat | Consultar a API de execuções de cada repositório e baixar logs por link que expira em 1 minuto. Granularidade igual à dos passos do YAML | Ler os eventos de um banco só |
| Agendamento | Intervalo mínimo de 5 minutos, pode atrasar sob carga e a documentação admite descarte de execuções | pg_cron a cada minuto, já em uso no publicador |
| Onde fica a aprovação e a publicação | Continuam no Sr. Post: seriam dois sistemas para conciliar | No mesmo sistema |
| Custo | Minutos de Actions por repositório privado; esperar geração de vídeo consome minutos | Uma chamada por minuto por agendador, dentro da cota da função |

**Escolha: opção B.** Três razões: instalação zero por agente, o Sr. Post já é o sistema de registro (fila de aprovação, contas conectadas, ritmo, publicação) e a visão ao vivo e o chat precisam de um único lugar com os eventos.

Riscos reais da opção B e como foram tratados:

1. **Limites da Edge Function** (150 segundos por chamada no plano gratuito, 256 MB de memória). Cada execução avança uma etapa por vez, a geração de mídia nunca espera dentro da chamada (inicia e consulta nos ciclos seguintes) e há um teto de tempo por ciclo.
2. **Raio de impacto compartilhado.** O motor dos agentes tem agendador e trava próprios (`/agents/tick`, chave `agents_lock`), separados do publicador (`/worker/tick`). Um ciclo lento de geração não atrasa a publicação. Cada execução roda dentro do próprio tratamento de erro e grava o evento de falha.

Fica **A VERIFICAR**: projetos no plano gratuito do Supabase pausam depois de um período de pouca atividade, e não confirmei se o tráfego do agendador conta como atividade. O plano Pro elimina a dúvida.

A decisão passou por três avaliadores independentes, cada um por um ângulo (instalação de um agente, manutenção de muitos, confiabilidade e custo). Os três escolheram o backend, com confiança alta. O que eles apontaram contra, e que vale como limite conhecido:

- **Trabalho pesado de mídia não cabe na função.** Não há ffmpeg nem composição de imagem com texto dentro da Edge Function. Converter foto em vídeo, montar slide com texto ou recodificar arquivo tem de acontecer no gerador externo ou antes do envio. Se um dia o Sr. Post precisar renderizar mídia por conta própria, essa parte vira um serviço à parte (desenho híbrido).
- **A fricção real por agente é conectar a conta do cliente.** Enquanto o app da Meta não passar pela revisão, só contas com papel no app conseguem conectar o Instagram. Isso independe da escolha entre GitHub e backend.
- **Limite de processamento por chamada** (2 segundos de CPU). Com muitos agentes, a etapa que observa aprovações e publicações é a primeira a medir. Hoje ela faz três consultas por ciclo, independente do número de agentes.

## 3. Desenho

```
Painel do time (portal/agentes.html)
  Central de agentes   Novo agente   Ao vivo   Chat de diagnóstico
        |                  |            |              |
        v                  v            v              v
  /admin/agents      POST /admin/agents  /admin/agents/live   /admin/chat
        |                                       ^              |
        v                                       |              v
  agents (configuração)                   agent_events   consultas de leitura
        |                                       ^        (agentes, execuções,
        v                                       |         posts, tentativas)
  pg_cron (1 min) -> /agents/tick -> motor (lib/agents.ts)
                                       |
     planejar -> roteiro -> copy -> mídia -> aprovação -> publicar
        |           |         |       |          |            |
     TextGenerator (Claude)        MediaGenerator   fila do     publicador
                                   (manual, gerador portal      existente
                                    externo)        (cliente)   (/worker/tick)
```

### Dados (migração `0006_agent_engine.sql`, só aditiva)

- `agents` ganhou: `context`, `audience`, `formats`, `voice`, `default_link`, `approval_mode`, `automation`, `text_provider`, `media_provider`, `story_default`, `ai_label`, `lead_hours`, `config_version`, `last_run_at`.
- `agent_runs`: uma execução é um post em produção. Guarda a etapa atual, o status, o horário do post, o formato e os dados produzidos em cada etapa (plano, roteiro, copy, pedido e resultado da mídia).
- `agent_events`: a linha do tempo real. Cada etapa grava `iniciou`, `ok`, `falhou`, `aguardando` ou `info`, com mensagem, detalhe e duração.
- `diag_chats`: histórico do chat de diagnóstico, com as consultas que cada resposta usou.

### Motor (`lib/agents.ts`)

A cada minuto:

1. **Agenda.** Para cada agente com a automação ligada, calcula os horários da semana (frequência espalhada entre os horários do agente, no fuso do cliente) e cria uma execução para cada horário que cai dentro da antecedência configurada (`lead_hours`).
2. **Observa.** Para as execuções que esperam o cliente ou a publicação, compara o estado real do criativo e dos posts com o último estado visto e grava os eventos: aprovado, reprovado, pediu ajuste, enviando, publicado, falhou.
3. **Avança.** Executa a etapa atual de cada execução pronta para andar, uma etapa por execução.

Etapas:

| Etapa | O que faz | Quem faz |
| --- | --- | --- |
| planejar | Escolhe o tema e o ângulo do post para o pilar e o formato da vez, sem repetir os temas recentes | `TextGenerator` |
| roteiro | Opções de abertura com nota, abertura escolhida, roteiro por trecho (Reel) ou slides (carrossel), conceito visual | `TextGenerator` |
| copy | Legenda e hashtags, seguidas de uma revisão determinística (frases com cara de IA, travessão, excesso de hashtags) | `TextGenerator` + `reviewCopy` |
| mídia | Pede a mídia ao fornecedor e consulta até ficar pronta. No modo manual, espera o time enviar pelo painel, com o briefing na tela | `MediaGenerator` |
| aprovação | Coloca o criativo na fila do cliente no portal, com legenda, link e opções. No modo automático, aprova sozinho | Sr. Post |
| publicar | O publicador existente publica respeitando o ritmo por conta. O motor só registra o que aconteceu | Sr. Post |

Pedido de ajuste do cliente: a execução volta para o roteiro com o pedido como instrução e gera uma nova versão (até 3). Falha em etapa de geração: nova tentativa em 2, 10 e 30 minutos; depois disso a execução para com o erro registrado. Erro de configuração (chave ausente) para na hora, com mensagem clara.

### Fornecedores trocáveis (`lib/gentypes.ts`, `lib/generators.ts`)

O motor só conhece duas interfaces. Trocar de fornecedor é escrever outra implementação.

| Interface | Implementações | Situação |
| --- | --- | --- |
| `TextGenerator` (plano, roteiro, copy) | `claude` | Código pronto. Depende do segredo `ANTHROPIC_API_KEY` na função |
| | `simulado` | Só em cliente de demonstração. Texto de exemplo, marcado como simulação |
| `MediaGenerator` (imagem, carrossel, vídeo) | `manual` | O time envia a mídia pelo painel a partir do briefing. É o padrão, e reproduz o fluxo atual em que a mídia chega pronta |
| | `higgsfield` | Adaptador escrito a partir da documentação pública da API. **A VERIFICAR**: não testado com chave real; preços por modelo e proporção do vídeo dependem do primeiro uso |
| | `simulado` | Só em cliente de demonstração. Usa mídias de exemplo |

Simulação nunca roda em cliente real: a API recusa e o banco recusa conta simulada fora de demonstração.

## 4. As cinco partes do painel

1. **Central de agentes.** Lista todos os agentes por conta: status, automação ligada ou pausada, última execução, próximos posts, erros dos últimos 7 dias e o que falta para o agente andar sozinho (conectar conta, enviar mídia, cliente aprovar). Edição da configuração de cada um e atualização em lote de um ou de todos.
2. **Novo agente.** Poucas perguntas: contexto da conta, tipo de postagem, redes, frequência e horários. Cria o cliente, o agente e o link do portal, mostra o link que leva o cliente direto à tela de conexão do Instagram e do TikTok e já deixa a automação ligada.
3. **Ao vivo.** Cada agente é um nó ligado às seis etapas. As linhas acendem quando a etapa roda de verdade, a partir dos eventos gravados no banco. Sem evento, nada acende.
4. **Chat de diagnóstico.** Pergunta em linguagem natural ("por que o post de tal conta falhou?", "dá para fazer tal coisa?"). O chat consulta agentes, execuções, eventos, posts e tentativas e responde em texto simples com o registro relevante. Somente leitura.
5. **TikTok.** Mesmas telas; a conexão e a publicação passam pelo provedor atrás do `PublisherAdapter`.

## 5. Contrato da API do painel

Todas as rotas usam o cabeçalho `x-admin-key`.

| Rota | Uso |
| --- | --- |
| `GET /admin/agents` | Central: agentes com status, execuções ativas, próximos posts, erros e pendências, mais o estado do motor e dos fornecedores |
| `POST /admin/agents` | Assistente: cria cliente, agente e link do portal |
| `GET /admin/agents/{cliente}` | Configuração completa, próximos horários e as 30 execuções mais recentes |
| `PATCH /admin/agents/{cliente}` | Atualiza a configuração de um agente |
| `POST /admin/agents/bulk` | Atualiza vários agentes ou todos (`client_ids: "all"`) |
| `POST /admin/agents/{cliente}/run` | Roda agora (uma execução fora da agenda) |
| `GET /admin/agents/live?after=&client_id=` | Eventos depois do cursor e execuções em andamento |
| `GET /admin/runs/{id}` | Uma execução com todos os eventos |
| `POST /admin/runs/{id}/media` | Envia a mídia de uma execução no modo manual |
| `POST /admin/runs/{id}/cancel`, `/retry` | Cancela ou retoma uma execução |
| `POST /admin/chat` | Pergunta ao chat de diagnóstico |
| `GET /admin/chat/history` | Perguntas anteriores |

## 6. Plano por fases

| Fase | Entrega | Situação |
| --- | --- | --- |
| 1 | Modelo de dados, motor, agendador próprio, fornecedores (manual, simulado, Claude, Higgsfield), API da central | Ver seção 8 |
| 2 | Painel: central, novo agente, ao vivo | Ver seção 8 |
| 3 | Chat de diagnóstico somente leitura | Ver seção 8 |
| 4 | TikTok: correções do adaptador conferidas com a documentação, simulação e lista do que falta do seu lado | Ver seção 8 |

## 7. O que depende de você

| Item | Para quê | Onde |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Texto, roteiro e copy por Claude, e o chat em linguagem natural | Supabase, Edge Functions, Secrets |
| Chave da API do Higgsfield (ou confirmar outro gerador) | Imagem e vídeo gerados sozinhos | Supabase, Edge Functions, Secrets |
| Conta e chave do provedor de TikTok | Conectar e publicar no TikTok dos clientes | Ver `docs/TIKTOK.md` |

Sem a chave do Claude, o agente de um cliente real para na primeira etapa com o motivo escrito, e o chat responde pelo modo de regras (consultas fixas, sem interpretação livre).

## 8. Situação e testes

Preenchido ao fim de cada fase.
