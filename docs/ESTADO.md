# Estado do Sr. Post (para retomar sem perder contexto)

Atualizado em 15/11/2026. Este arquivo diz o que está no ar, o que está pronto mas não testado de ponta a ponta, o que falta e o próximo passo. Detalhes de arquitetura: `docs/AGENTES.md`. Portal e publicação: `docs/PORTAL.md`. TikTok: `docs/TIKTOK.md`. Entrada do agente por API: `docs/AGENTE.md`.

## Onde cada coisa roda

| Peça | Onde | Observação |
| --- | --- | --- |
| Portal do cliente, painel do time, central de agentes | GitHub Pages, branch `main`, pasta `portal/` | Só vai ao ar depois do merge na `main` |
| Função `api` | Supabase Edge Functions | Portal, painel, ingestão, Instagram, publicador (`/worker/tick`) |
| Função `agents` | Supabase Edge Functions | Central de agentes, banco de pautas, chaves, motor (`/tick`) |
| Função `chat` | Supabase Edge Functions | Chat de diagnóstico, somente leitura |
| Função `render` | Supabase Edge Functions | Arte por template (imagem JPEG), sem chave externa |
| Agendadores | pg_cron, a cada minuto | `srpost-worker` chama `api/worker/tick`; `srpost-agents` chama `agents/tick` |
| Banco | Postgres do Supabase, migrações `supabase/migrations/0001` a `0008` | Todas aplicadas |

### Como publicar as funções

O código-fonte fica em `supabase/functions/api/lib`. As funções `api`, `agents` e `chat` são publicadas como um arquivo só, gerado por `supabase/functions/build.sh` (esbuild; só remove comentários, mantém uma instrução por linha). O motivo: a ferramenta de publicação recebe o código inteiro numa chamada, e o código completo passa de 400 KB. Separadas, cada função fica entre 90 e 155 KB.

```bash
ESBUILD=/caminho/do/esbuild ./supabase/functions/build.sh /tmp/dist
```

Depois de publicar, conferir: `/health` de cada função e o código publicado byte a byte contra o arquivo gerado.

## Pronto e testado em produção

- Portal: fila de aprovação, opções por criativo (story, legenda, música, local, com motivo quando a rede não aceita), andamento ao vivo, reconexão, visualização grande.
- Publicação real no Instagram (`utmbuilder.com.br`): foto no feed. Story aprovado e agendado.
- Ritmo por conta (intervalo, teto diário, pausa por suspeita de spam), histórico de tentativas, isolamento entre clientes.
- Arte por template: a função `render` gera JPEG 1080x1350 e 1080x1920 em cerca de 0,3 s depois de aquecida.

## Pronto no código, publicado, ainda sem teste de ponta a ponta

- Motor dos agentes (planejar, roteiro, copy, mídia, aprovação, publicar), com eventos reais.
- Central de agentes, assistente Novo agente, visão ao vivo, chat de diagnóstico (`portal/agentes.html`).
- Banco de pautas (texto pronto, sem chave do Claude) e arte por template como gerador padrão.
- Chaves e integrações: estado, onde colar, botão de testar (rotas em `agents`; tela em Configuração do painel).
- Geração de texto pelo Claude e mídia pelo Higgsfield: código escrito e testado contra servidores falsos. Sem chave real.

## Falta (em ordem)

1. Teste de ponta a ponta pelo painel com cliente de demonstração e depois com o UTM Builder (banco de pautas sobre UTM, sem repetir tema).
2. PR e merge na `main` a cada fase publicada e testada; conferir o Pages em produção.
3. Vídeo curto pelo gerador padrão (Reels). A função não tem ffmpeg; o caminho em estudo é montar o MP4 a partir das artes, sem recodificar.
4. Música em Reels pela API de áudio do Instagram: confirmar na documentação da Meta e com o token real antes de implementar.
5. Localização por busca de nome ou link da Página.
6. Comentários e mensagens diretas por regras, com caixa de entrada.
7. Relatório semanal de tendências por cliente.
8. TikTok: correções do adaptador conferidas com a documentação (pesquisa pronta em `docs/TIKTOK.md`), ainda não aplicadas no código.

## Próximo passo

Rodar `t5_agents` (roteiro de teste de ponta a ponta da central) contra produção com cliente de demonstração, corrigir o que falhar, abrir o PR e fazer o merge.
