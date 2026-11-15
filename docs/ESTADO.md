# Estado do Sr. Post (para retomar sem perder contexto)

Atualizado em 14/11/2026, 23:57 (Brasília). Arquitetura: `docs/AGENTES.md`. Portal: `docs/PORTAL.md`. TikTok: `docs/TIKTOK.md`. Entrada por API: `docs/AGENTE.md`. Meta: `docs/META-CONFIG.md`.

## No ar (Supabase)

| Peça | Versão | Conferência |
| --- | --- | --- |
| Função `api` (portal, painel, ingestão, Instagram, publicador) | v13 publicada às 23:5x | `/health` 200 e portal com token inválido 401. A conferência byte a byte foi interrompida no fim: refazer |
| Função `agents` (central, banco de pautas, chaves, motor `/tick`) | v1 | Byte a byte ok; agendador sem erros |
| Função `chat` (diagnóstico, somente leitura) | v1 | Ok |
| Função `render` (arte por template e story 9:16) | v2 | Byte a byte ok; story 4:5 vira 1080x1920 |
| Migrações | 0001 a 0009 | Todas aplicadas |
| Portal no GitHub Pages | `main` (até `a0172ae`, com a caixa de entrada do gestor) | `agentes.html` e o painel de chaves ainda não estão na `main` |

Como publicar as funções: `ESBUILD=/caminho/esbuild ./supabase/functions/build.sh /tmp/dist` gera `api`, `agents` e `chat` como arquivo único; `render` vai como código-fonte. Depois conferir `/health` e o código publicado byte a byte.

## Pronto e testado

- Publicação real no Instagram (foto e story) e ritmo por conta, isolamento entre clientes.
- Story 9:16: rota de ajuste da `render` testada em produção.
- Teste de ponta a ponta da central (`t5_agents.py`, cliente demo), parte 1 e 2: Novo agente, contas simuladas, execução até a fila, arte por template, aprovação no portal. Parado no meio da publicação por ordem do dono.

## Pela metade (não publicado no portal)

- Story 9:16 no publicador (`api` v13): falta teste de ponta a ponta com story real.
- Música nos Reels: confirmada com o token real (`/ig_audio`, em alta e busca, HTTP 200). Código não escrito.
- Localização: busca por nome e link de Página pública exigem Page Public Metadata Access (pedido em `docs/META-CONFIG.md`). Código não escrito.

## Atenção

- O gestor reconectou o Instagram do UTM Builder às 23:45 para incluir comentários e mensagens (`instagram_manage_comments`, `instagram_manage_messages`). A conta está conectada com id novo `9fb6d675-9a6f-4502-a802-71805491ca8b`; o id antigo `3d672998-...` não existe mais.
- Os testes de hashtag, perfil de referência e local por contêiner usaram o id antigo e rodaram sem token: refazer com o id novo.

## Próximo passo exato

1. Conferir a `api` v13 byte a byte contra `dist3/api/index.js` (gerado de novo com `build.sh`).
2. Rodar `t5_agents.py` inteiro e o teste da interface (`t6_painel.js`); corrigir o que falhar.
3. Abrir o PR (só `portal/`, `supabase/`, `docs/`), fazer o merge e conferir o Pages em produção.

## Fila

0. Story 9:16 no publicador: falta o teste com story de demonstração. Às 23:58 nenhuma conta simulada estava livre (todas com post nos últimos 20 minutos); criar um story aprovado num cliente demo e conferir `media_url` terminando em `-story.jpg` e `fit_source` preenchido.
1. FEITO NA BRANCH, NÃO PUBLICADO (falta testar no navegador e fazer o merge): botões "Caixa de entrada" (pedido do gestor; a caixa já está no ar: função `inbox` v2, tabelas `inbox_*`, cron `srpost-inbox`, `portal/caixa.html`, PR #4 na `main`). No portal, aba Agente ou topo: link para `caixa.html#<token do portal>`. No painel: link para `caixa.html?time=1` (usa a chave `srpost.admin.key` do localStorage). Não mexer em mais nada da caixa. Depois de cada merge, mandar ao gestor a lista do que testar em produção.
2. Música nos Reels: busca no portal, `audio_configuration` no contêiner `REELS`; foto e story desativados com o motivo.
3. Localização: aceitar link da Página do local; validar com a Graph quando houver o recurso; sem ele, só ID numérico e mensagem clara se a Meta recusar.
4. Vídeo curto pelo gerador padrão (Reels), sem ffmpeg.
5. Teste real no UTM Builder: story, foto, carrossel e Reels com legenda, local e música.
6. Relatório semanal de tendências por cliente; correções do adaptador do TikTok.
7. Envio em lote pelo painel (pedido do dono, sem geração por IA): subir um ZIP com vários criativos prontos (imagens e vídeos). A legenda é opcional, por arquivo `.txt` com o mesmo nome da mídia ou por uma planilha CSV. Cada criativo entra direto na fila de aprovação do cliente, com a data e a hora de publicação escolhidas pelo time.
