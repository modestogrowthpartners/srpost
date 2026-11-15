# Configuração da Meta: o que o Sr. Post precisa

Atualizado em 15/11/2026. Este arquivo é lido pela sessão gestora, que configura o painel da Meta pelo navegador. Ele lista só o que as frentes de publicação, música, localização e tendências precisam. Comentários e DM ficam com a sessão gestora (função `inbox`); os achados da minha pesquisa sobre eles estão no fim, sem implementação.

## Resumo: o que fazer

| # | Item | Ação no painel da Meta | Urgência |
| --- | --- | --- | --- |
| 1 | Login e URLs atuais | Nenhuma. Só conferir a tabela da seção 1 | Conferência |
| 2 | Música nos Reels | Nenhuma. Funcionou com o token atual (teste na seção 2) | Nenhuma |
| 3 | Localização por busca de nome ou link da Página | Pedir o recurso **Page Public Metadata Access** (acesso avançado) | Quando o dono quiser busca por nome |
| 4 | Hashtags e perfis de referência no relatório de tendências | Pedir o recurso **Instagram Public Content Access** (acesso avançado) | Opcional |
| 5 | Clientes que não têm papel no app | Acesso avançado das 5 permissões atuais (App Review e verificação da empresa, ver `docs/APP-REVIEW.md`) | Antes de abrir para clientes de fora |

Os itens 3, 4 e 5 passam pelo App Review e exigem a verificação da empresa (Business Verification). Dá para enviar tudo no mesmo pedido.

## 1. App, login e URLs (não mudar)

| Campo | Valor |
| --- | --- |
| App | Sr. Post, ID `1014813347720716` |
| Produto de login | Facebook Login for Business, configuração `1724468293011778` |
| Tipo de token | O token salvo da conta `utmbuilder.com.br` não expira e não tem Página ligada, o que indica token de usuário do sistema. A VERIFICAR na configuração de login |
| Permissões na configuração | `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement` (mais `public_profile`, automático) |
| URI de redirecionamento OAuth válido | `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/instagram/callback` |
| URL de desautorização | `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/instagram/deauthorize` |
| URL de exclusão de dados | `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/instagram/data-deletion` |
| Política de privacidade | `https://modestogrowthpartners.github.io/srpost/portal/privacidade.html` |
| Termos de uso | `https://modestogrowthpartners.github.io/srpost/portal/termos.html` |
| Instruções de exclusão | `https://modestogrowthpartners.github.io/srpost/portal/exclusao-de-dados.html` |
| Domínios do app | `qmmhqhebxynycjxqxber.supabase.co` e `modestogrowthpartners.github.io` |

Não acrescentar `business_management` nem outras permissões na configuração de login sem uso no produto: a Meta reprova pedido de permissão sem uso visível.

Publicação, música e localização não usam webhook. O publicador consulta o estado do contêiner a cada minuto.

## 2. Música nos Reels: nada a configurar

- **Fonte:** guia oficial "Audio API" da Meta (`https://developers.facebook.com/docs/instagram-platform/content-publishing/audio-api/`) e o changelog da Instagram Platform (entrada de 1/6/2026, "Introducing the Instagram Audio API for apps using Facebook Login").
- **Busca:** `GET /ig_audio?audio_type=music&user_id={IG_USER_ID}`. Sem `search_query`, devolve os áudios em alta; com `search_query`, busca por palavra.
- **Uso:** o `audio_id` vai em `audio_configuration` ao criar o contêiner `REELS`. Só Reels: foto, carrossel e story continuam sem música.
- **Requisitos:** `instagram_basic` e `instagram_content_publish`, que já estão na configuração. Disponível com Facebook Login e com Unified Login; não funciona com Instagram Login.
- **Teste real em 15/11/2026**, conta `utmbuilder.com.br`, token atual, v27.0:
  - lista em alta: HTTP 200 com `audio_id`, título, artista e duração;
  - busca por "samba": HTTP 200.
- **Catálogo:** a documentação diz que vêm só áudios liberados para uso por terceiros e que a lista pode ser diferente da do app. Não confirmei se artistas grandes aparecem.
- **Paginação e limite de chamadas:** não documentados. A VERIFICAR.

## 3. Localização: pedir Page Public Metadata Access

- **Como o Instagram recebe o local:** `location_id` é o ID de uma Página do Facebook que tenha endereço (campo `location` com latitude e longitude). Vale para foto, Reels e para o carrossel (no contêiner pai). Story não aceita local pela API ("Publishing stickers (i.e., link, poll, location) is not supported").
- **Busca por nome:** só existe pela Pages Search API (`GET /pages/search?q=...&fields=id,name,location,link`). A antiga busca de lugares (`/search?type=place`) foi desativada em 2020.
- **Teste real em 15/11/2026** com o token atual:
  - `GET /pages/search?q=Avenida Paulista`: HTTP 400, `Authorization Error` (código 100);
  - leitura de uma Página pública pelo nome (`GET /facebook?fields=id,name,location`): HTTP 400, `(#10) This endpoint requires the 'pages_read_engagement' permission or the 'Page Public Content Access' feature or the 'Page Public Metadata Access' feature`.
- **Conclusão:** sem o recurso, não dá para buscar por nome nem validar o link de uma Página pública. `pages_read_engagement` só vale para Páginas que a pessoa administra.
- **O que pedir:** recurso **Page Public Metadata Access** (é o mais estreito: nome, endereço e dados públicos da Página). A página do recurso diz que ele foi substituído pelo **Page Public Content Access** e que não pode ser pedido se este já tiver sido pedido ou aprovado. Se o painel não oferecer o primeiro, peça o segundo. Os dois exigem App Review e verificação da empresa.
- **Texto sugerido para o formulário:**
  > When a client approves a post in the Sr. Post portal, they can tag a location. We use Page Public Metadata Access only to search public Facebook Pages by name and read their name and address (location field), so the client can pick the right place and we can send its Page ID as location_id when publishing to their own Instagram professional account. We do not read posts, comments or any other content of those Pages.
- **Enquanto não houver o recurso**, o portal aceita o link da Página do local. Quando o link traz o ID numérico (`facebook.com/profile.php?id=...`), o ID é usado e a própria Meta valida na publicação; se o local for recusado (`INSTAGRAM_PLATFORM_API__INVALID_LOCATION_ID`), o cliente vê o motivo e pode publicar sem local.

## 4. Tendências: Instagram Public Content Access (opcional)

- **Teste real em 15/11/2026** com o token atual:
  - busca de hashtag (`GET /ig_hashtag_search?q=marketingdigital`): HTTP 403, `(#200) Provide valid app ID`;
  - consulta de perfil público de referência (`business_discovery`): HTTP 403, mesma mensagem.
- **Requisito documentado da busca de hashtag:** App Review do recurso **Instagram Public Content Access** mais `instagram_basic`. Limite: 30 hashtags diferentes por conta a cada 7 dias.
- **Sem o recurso**, o relatório semanal usa o que já funciona: desempenho dos posts do próprio cliente (`instagram_manage_insights`), formatos e hashtags que o cliente já usou, e músicas em alta (`/ig_audio`).
- O motivo exato do erro em `business_discovery` não está claro (a mensagem fala de ID do app). A VERIFICAR depois da aprovação do recurso.

## 5. Comentários e DM (com a sessão gestora)

Não implemento nada aqui. Quando a pesquisa em andamento terminar, os achados entram nesta seção para consulta.
