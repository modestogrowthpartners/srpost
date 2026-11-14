# Portal do cliente Sr. Post

Portal onde o cliente aprova os criativos arrastando (direita aprova, esquerda reprova, para cima pede ajuste), acompanha os posts e conecta o Instagram. O time usa um painel separado para cadastrar clientes, gerar links e subir criativos.

## O que existe

| Peça | Onde fica |
| --- | --- |
| Portal do cliente | `portal/index.html` (GitHub Pages: `/srpost/portal/`) |
| Painel do time | `portal/admin.html` (`/srpost/portal/admin.html`) |
| Endereço da API | `portal/config.js` |
| API (Edge Function `api`) | `supabase/functions/api/` |
| Banco | `supabase/migrations/0001_portal_schema.sql` |
| Projeto Supabase | `srpost` (ref `qmmhqhebxynycjxqxber`, região São Paulo) |

## Como funciona

1. O time cadastra o cliente e o agente no painel e gera um **link de acesso**. O link abre o portal sem senha. O token fica só no aparelho do cliente; no banco fica apenas o hash.
2. Os criativos entram na fila pelo painel (upload) ou pela API de ingestão (n8n, agente gerador).
3. O cliente decide cada criativo. Aprovado vira um post agendado: na data sugerida ou, se não houver, no próximo horário livre do agente.
4. A cada 5 minutos o publicador (pg_cron chamando `/worker/tick`) publica os posts vencidos pela API do Instagram, renova tokens e atualiza métricas.
5. O cliente vê na aba Posts o que foi agendado, publicado, o que está em ajuste e os números de cada post.

## Segurança

- Todas as tabelas têm RLS ligado, sem policies e sem permissão para `anon`/`authenticated`. Só a Edge Function (service role) acessa o banco.
- Tokens do Instagram ficam no Supabase Vault (criptografados em repouso), lidos só por funções restritas ao service role.
- Painel e ingestão usam chaves (`srp_adm_...` e `srp_ing_...`) guardadas como hash. Crie uma chave por pessoa ou sistema e revogue quando precisar (Painel > Configuração).
- O bucket `creatives` é público porque o Instagram precisa baixar a mídia por URL. Os caminhos têm UUID aleatório.

## Conexão com o Instagram (Facebook Login for Business)

O app da Meta do Sr. Post (ID `1014813347720716`) usa o login unificado: o cliente entra com o Facebook, libera a Página e o Instagram profissional ligado a ela, e a API publica com o token da Página (`graph.facebook.com`).

O que precisa estar configurado:

1. **Segredos da Edge Function** (Supabase > Edge Functions > Secrets): `IG_APP_ID` e `IG_APP_SECRET`, com o ID e a chave secreta do app da Meta.
2. **Configuração de login** (Facebook Login for Business > Configurations): o ID fica na tabela `settings`, chave `ig_login_config_id` (hoje `1724468293011778`). Para trocar sem redeploy, atualize essa linha ou crie o segredo `IG_LOGIN_CONFIG_ID`.
3. **Permissões da configuração de login**: `instagram_basic`, `instagram_content_publish`, `pages_show_list` e `pages_read_engagement` são obrigatórias (sem elas a conexão é recusada com o motivo "permissoes"). `instagram_manage_insights` é necessária para as métricas dos posts.
4. **URLs cadastradas na Meta** (aparecem em Painel > Configuração):
   - Redirecionamento OAuth válido: `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/instagram/callback`
   - Desautorização: `.../api/instagram/deauthorize`
   - Exclusão de dados: `.../api/instagram/data-deletion`

Requisitos do cliente: Instagram profissional (Empresa ou Criador) ligado a uma Página do Facebook que ele administra. Se a Página exigir Autorização de Publicação da Página (PPA), ela precisa estar concluída.

Enquanto o app estiver em modo de desenvolvimento, só pessoas com papel no app (administrador, desenvolvedor ou testador) conseguem conectar. Para liberar qualquer cliente, o app precisa de acesso avançado às permissões acima via App Review (verificação da empresa, política de privacidade publicada e vídeo do fluxo).

Se o cliente liberar mais de uma conta no login, o portal conecta a primeira e avisa. Para escolher outra, ele desconecta e refaz o login marcando só a conta desejada.

Diagnóstico: a última falha de conexão fica registrada e aparece em Painel > Configuração. A versão da API é `v27.0` por padrão; para mudar, crie o segredo `IG_API_VERSION`.

## API de ingestão (n8n ou agente gerador)

Crie uma chave do tipo Ingestão em Painel > Configuração e envie no cabeçalho `x-api-key`.

```bash
curl -X POST "https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/ingest/creatives" \
  -H "x-api-key: srp_ing_SUA_CHAVE" -H "content-type: application/json" \
  -d '{
    "client_slug": "identificador-do-cliente",
    "items": [{
      "media_url": "https://exemplo.com/video.mp4",
      "kind": "video",
      "format": "reel",
      "title": "Título interno",
      "caption": "Legenda do post",
      "hashtags": "#exemplo",
      "suggested_at": "2026-11-20T18:30:00-03:00",
      "ai_generated": true,
      "external_ref": "id-unico-do-seu-fluxo"
    }]
  }'
```

- `format`: `reel` (vídeo), `feed` (imagem) ou `story`. `kind`: `video` ou `image`.
- `external_ref` evita duplicar o mesmo criativo se o fluxo rodar duas vezes.
- `media_url` precisa ser https e continuar pública até a publicação. Para hospedar no Supabase, peça uma URL de upload em `POST /ingest/upload-url` (`client_slug`, `filename`, `content_type`), envie o arquivo com `PUT` na `signed_url` e use o `path` retornado como `media_path`.

## Limites conhecidos

- **Tamanho de arquivo:** 50 MB por mídia (limite do bucket, alinhado ao plano gratuito do Supabase). O Instagram aceita Reels de até 300 MB; para arquivos maiores é preciso plano pago ou hospedar a mídia fora.
- **Formato:** Reels em MP4 ou MOV com H.264 e áudio AAC. Imagens do feed em JPEG, proporção entre 4:5 e 1,91:1 (o painel converte para JPEG, mas não recorta).
- **Carrossel** ainda não é suportado.
- **TikTok** não está integrado: exige app e auditoria próprios do TikTok.
- **Limite do Instagram:** a documentação da Meta cita 100 posts publicados por API a cada 24 horas por conta (um trecho antigo ainda cita 50).
- Métricas chegam cerca de 1 hora após a publicação e são atualizadas a cada hora nos 3 primeiros dias, depois a cada 12 horas.

## Publicar alterações

- Telas: commit em `portal/` e merge na `main` (GitHub Pages publica sozinho).
- API: redeploy da função `api` no Supabase (`supabase functions deploy api --no-verify-jwt`).
- Banco: nova migration em `supabase/migrations/`.
