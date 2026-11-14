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

## Configurar a conexão com o Instagram (API nativa da Meta)

Sem este passo o portal funciona, mas o botão "Conectar Instagram" fica como "em liberação" e nada é publicado.

1. Em developers.facebook.com, crie um app do tipo **Business**.
2. Adicione o produto **Instagram** e escolha **API setup with Instagram business login**.
3. Nas configurações de Business login, cadastre os três endereços que aparecem em Painel > Configuração:
   - URI de redirecionamento do OAuth: `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/instagram/callback`
   - URL de desautorização: `.../api/instagram/deauthorize`
   - URL de exclusão de dados: `.../api/instagram/data-deletion`
4. Copie o **Instagram App ID** e o **Instagram App Secret** (ficam na tela do produto Instagram; confira se são os do Instagram, não os do app Meta).
5. No Supabase: Edge Functions > Secrets. Crie `IG_APP_ID` e `IG_APP_SECRET`.
6. Enquanto o app estiver em modo de desenvolvimento, só contas com papel no app conseguem conectar. Em Funções do app, adicione cada conta do Instagram como **Instagram Tester** e peça para o dono aceitar o convite no próprio Instagram.
7. Para liberar qualquer cliente, envie o app para **App Review** pedindo acesso avançado a `instagram_business_basic`, `instagram_business_content_publish` e `instagram_business_manage_insights`. A Meta pede verificação da empresa, política de privacidade publicada e um vídeo mostrando o fluxo.

Permissões usadas: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`. A versão da API é `v27.0` por padrão; para mudar, crie o segredo `IG_API_VERSION`.

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
