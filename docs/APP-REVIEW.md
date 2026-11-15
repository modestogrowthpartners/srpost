# App Review da Meta: o que entregar

Material para pedir acesso avançado às permissões do app **Sr. Post** (ID `1014813347720716`), que usa Facebook Login for Business (configuração `1724468293011778`). Enquanto o app não for aprovado, só pessoas com papel no app conseguem conectar.

## 1. Antes de enviar

| Item | Situação | Onde |
| --- | --- | --- |
| Política de Privacidade pública | Pronta | `https://modestogrowthpartners.github.io/srpost/portal/privacidade.html` |
| Termos de Uso públicos | Prontos | `https://modestogrowthpartners.github.io/srpost/portal/termos.html` |
| Instruções de exclusão de dados | Prontas | `https://modestogrowthpartners.github.io/srpost/portal/exclusao-de-dados.html` |
| Callback de exclusão de dados | Pronto | `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/instagram/data-deletion` |
| Callback de desautorização | Pronto | `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/instagram/deauthorize` |
| Ícone do app 1024x1024 | A fazer | Configurações do app > Básico |
| Categoria do app e e-mail de contato | A conferir | Configurações do app > Básico |
| Verificação da empresa (Business Verification) | A fazer | Central de Segurança do portfólio empresarial |
| 1 chamada bem-sucedida por permissão | A fazer | Conecte uma conta de teste pelo portal, aprove um post e espere a publicação e as métricas |

A Meta só libera o pedido de acesso avançado depois de pelo menos uma chamada bem-sucedida de cada permissão. O caminho mais simples é rodar o roteiro do vídeo uma vez com uma conta que tenha papel no app.

Peça somente as permissões abaixo. Pedir permissão que o app não usa é motivo de reprovação. Se a configuração de login incluir outras (por exemplo `business_management`), tire da configuração ou acrescente a justificativa correspondente.

## 2. Permissões e justificativas

Os textos em inglês são para colar no formulário. A Meta recomenda interface e explicações em inglês; como o portal está em português, o vídeo precisa de legendas em inglês.

### `pages_show_list`
- **Uso:** listar as Páginas do Facebook que a pessoa liberou no login, para achar a Página ligada à conta do Instagram que vai receber os posts.
- **Onde aparece:** portal > aba Agente > Contas conectadas > Conectar Instagram.
- **Texto para o formulário:**
  > Sr. Post is a content service for small businesses. The client connects their own Instagram professional account in our client portal. We use pages_show_list to read the list of Facebook Pages the client granted during login, so we can identify which Page is linked to the Instagram professional account that will receive the posts. We only read the Page ID and name. We do not post to the Page or read its content.

### `pages_read_engagement`
- **Uso:** exigida pela API de publicação do Instagram com login do Facebook. Lemos a conta do Instagram vinculada à Página e obtemos o token da Página usado para publicar.
- **Onde aparece:** mesmo fluxo de conexão; depois dela o portal mostra a conta conectada.
- **Texto para o formulário:**
  > We use pages_read_engagement to read the Instagram professional account linked to the Facebook Page the client selected, and to obtain the Page access token required by the Instagram content publishing endpoints. After connecting, the portal shows the connected Instagram username, profile picture and follower count so the client can confirm it is the right account.

### `instagram_basic`
- **Uso:** ler ID, nome de usuário, nome, foto e seguidores da conta profissional do Instagram, e o link do post publicado.
- **Onde aparece:** cartão "Instagram: Conectado" na aba Agente; link "Abrir" em cada post publicado na aba Posts.
- **Texto para o formulário:**
  > We use instagram_basic to read the connected Instagram professional account's ID, username, name, profile picture and follower count, which we display in the client portal, and to read the permalink of each post we publish so the client can open it.

### `instagram_content_publish`
- **Uso:** publicar na conta do cliente os posts que ele aprovou no portal: foto no feed, carrossel, Reels e stories, com legenda e, quando informado, local.
- **Onde aparece:** aba Aprovar (o cliente arrasta o cartão para a direita ou toca em Aprovar) e aba Posts (o post passa de Agendado para Publicado).
- **Texto para o formulário:**
  > We use instagram_content_publish to publish content to the client's own Instagram professional account. Our team prepares each post (feed photo, carousel, Reel or story). The client reviews every post in the portal and approves or rejects it. Only approved posts are published, at the scheduled time, through the content publishing endpoints. Nothing is published without the client's explicit approval, and the client can disconnect the account at any time.

### `instagram_manage_insights`
- **Uso:** ler as métricas dos posts publicados pelo Sr. Post (visualizações, alcance, curtidas, comentários, salvamentos, compartilhamentos e tempo médio) e mostrar ao cliente.
- **Onde aparece:** aba Posts, nos números de cada post e nos totais do topo.
- **Texto para o formulário:**
  > We use instagram_manage_insights to read performance metrics (views, reach, likes, comments, saves, shares and average watch time) of the posts published through Sr. Post, and show them to the client in the Posts tab of the portal, so they can see how each approved post performed. We do not read insights of other media or account-level audience data.

## 3. Roteiro do vídeo de demonstração

Um vídeo por permissão é o mais seguro, mas a mesma gravação pode ser enviada em todas se cobrir o fluxo inteiro. Grave em 1080p, com o cursor visível, sem cortes dentro de cada fluxo, e com legendas em inglês explicando cada botão.

Preparação: um cliente de teste criado no painel, com um Reel, uma foto e um carrossel na fila; uma conta do Instagram profissional de teste ligada a uma Página; a conta **desconectada** no início da gravação.

### Cena 1: login e concessão (cobre `pages_show_list`, `pages_read_engagement`, `instagram_basic`)
1. Abrir o link do portal do cliente de teste. Legenda: "Client portal of Sr. Post. Each client receives a private access link."
2. Ir na aba Agente. Mostrar o bloco Contas conectadas com "Instagram: Não conectado".
3. Clicar em **Conectar Instagram**. Legenda: "The client clicks Connect Instagram to start Facebook Login for Business."
4. Na tela da Meta, fazer login, escolher a Página e a conta do Instagram, e mostrar a lista de permissões pedidas antes de confirmar. Deixar a lista visível por alguns segundos.
5. De volta ao portal, mostrar o aviso "Instagram conectado" e o cartão com @, seguidores e nome da Página. Legenda: "We list the granted Pages (pages_show_list), read the linked Instagram account (pages_read_engagement) and show its profile (instagram_basic)."

### Cena 2: aprovação e publicação (cobre `instagram_content_publish`)
1. Aba Aprovar. Mostrar o cartão do Reel com legenda, data sugerida e "Publica em: Instagram". Legenda: "Each post prepared by our team waits for the client's decision."
2. Arrastar para a direita ou tocar em **Aprovar**. Mostrar o aviso "Aprovado. Vai ao ar ...".
3. Repetir com a foto e com o carrossel (passar as imagens pelas setas antes de aprovar).
4. Reprovar um criativo, para mostrar que o que não é aprovado não é publicado.
5. Aba Posts. Mostrar os itens como "Agendado" e, depois da publicação, "Publicado". Legenda: "Approved posts are published to the client's Instagram account with instagram_content_publish."
6. Clicar em **Abrir** e mostrar o post no Instagram, com a mesma legenda.

Para não esperar o horário agendado, deixe os criativos sem data sugerida e ajuste o horário do agente para o minuto seguinte, ou edite a data no painel. O publicador roda a cada minuto.

### Cena 3: métricas (cobre `instagram_manage_insights`)
1. Aba Posts, cerca de 1 hora depois da publicação. Mostrar os totais e os números de cada post. Legenda: "We read insights of the posts we published and show them to the client."
2. Abrir o mesmo post no Instagram e mostrar que as curtidas e comentários batem.

### Cena 4: controle do usuário e exclusão de dados
1. Aba Agente > **Desconectar** > confirmar. Mostrar "Não conectado". Legenda: "The client can disconnect at any time. The access token is deleted immediately."
2. Abrir a página Exclusão de dados e a Política de Privacidade pelos links do rodapé do portal.

## 4. Instruções de teste para o revisor

Texto para o campo de instruções:

> 1. Open the client portal link: [COLE O LINK DO CLIENTE DE TESTE]. No password is needed; the link identifies the test client.
> 2. Go to the "Agente" tab and click "Conectar Instagram". Log in with the test Facebook account below and grant the Page and the Instagram professional account.
> 3. Go to the "Aprovar" tab. Swipe a card right or click "Aprovar" to approve a post; swipe left or click "Reprovar" to reject.
> 4. Go to the "Posts" tab. Approved posts appear as "Agendado" and change to "Publicado" within about 5 minutes of the scheduled time. Metrics appear about one hour after publishing.
> 5. To remove access, go to "Agente" and click "Desconectar".
> Test Facebook account: [E-MAIL] / [SENHA]. It manages a Page linked to an Instagram professional test account.

Itens entre colchetes precisam ser preenchidos. Use uma conta de teste criada só para a revisão, nunca a de um cliente real, e deixe criativos na fila para o revisor ter o que aprovar.

## 5. Motivos comuns de reprovação

- Vídeo que não mostra a tela de login da Meta com as permissões.
- Permissão pedida sem uso visível no vídeo.
- Revisor não consegue reproduzir (link expirado, fila vazia, conta de teste sem Página ou sem Instagram profissional).
- Política de privacidade fora do ar ou sem explicar os dados recebidos da Meta e como apagá-los.

Não tenho a lista oficial de motivos de reprovação da Meta: os itens acima vêm dos requisitos da página de App Review e de relatos de terceiros. Vale conferir a página "Common Mistakes" da Meta antes de enviar.
