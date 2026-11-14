# TikTok: caminho de publicação

## Decisão

O TikTok é publicado pelo provedor **Upload-Post**, atrás da interface `PublisherAdapter` (`supabase/functions/api/lib/publishers.ts`). É o caminho que publica em público mais rápido: não depende de auditoria do TikTok para o Sr. Post.

## Comparação

| Critério | Content Posting API direta | Provedor (Upload-Post) |
| --- | --- | --- |
| Publicação pública | Só depois de o app passar na auditoria do TikTok. Sem auditoria, todo post sai em modo privado (`SELF_ONLY`) | Imediata: o app do provedor já é auditado |
| Limite sem auditoria | Até 5 usuários publicando a cada 24 horas, e as contas precisam estar privadas na hora do post | Não se aplica |
| Prazo para ir ao ar | Indefinido. A documentação do TikTok não informa prazo de auditoria | Criar a conta, escolher o plano e salvar a chave |
| O que precisa construir | App no TikTok for Developers, login, domínio verificado para envio por URL e a tela de publicação com os requisitos de UX do TikTok (nome do criador, seletor de privacidade sem padrão, consentimento de música, opções de interação desmarcadas) | Só a chamada de conexão e de upload. A tela de autorização é a do próprio TikTok |
| Onde fica o token do cliente | No Sr. Post | No provedor |
| Custo | Sem custo por perfil | Plano mensal por número de perfis. Para conectar contas de clientes pela API é preciso plano com white-label (Professional, 25 perfis, entre US$ 33 e US$ 50 por mês conforme o ciclo; confirme na página de preços) |
| Dependência | Só do TikTok | Do provedor: se ele sair do ar ou mudar preço, o TikTok para |
| Métricas por post | API própria do TikTok | Disponíveis pelo provedor, depois que o post é público e passou pela moderação |

## Como ativar

1. Criar a conta no Upload-Post e contratar um plano com white-label.
2. Gerar a chave de API no painel do provedor.
3. No Supabase: Edge Functions > Secrets, criar `UPLOAD_POST_API_KEY` com a chave.
4. Abrir `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/health` e conferir `"tiktok_configured": true`.
5. No painel do time, marcar TikTok nas redes do agente de cada cliente que vai usar.
6. O cliente abre o portal > Agente > Contas conectadas > **Conectar TikTok**, autoriza na tela do TikTok e volta conectado.

Cada cliente do Sr. Post vira um perfil no provedor (`srp_` + ID do cliente). Cada perfil conta no limite do plano.

## Como funciona no código

- `lib/uploadpost.ts`: cliente da API do provedor (perfil, conexão, upload, status, métricas).
- `lib/connect.ts`: início e retorno da conexão do TikTok no portal.
- `lib/publishers.ts`: adaptador `uploadpost`. Vídeo vai por `POST /api/upload`; foto e carrossel vão por `POST /api/upload_photos`. Todos com `privacy_level=PUBLIC_TO_EVERYONE` e envio em segundo plano.
- O worker acompanha o envio pelo `request_id` e marca o post como publicado quando o provedor confirma.

Se a conta do cliente no TikTok for privada, o TikTok recusa o post público e o erro aparece no painel do time.

## Migrar para a API direta no futuro

1. Criar o app no TikTok for Developers e pedir a auditoria da Content Posting API.
2. Criar um adaptador `tiktokDirect` em `lib/publishers.ts` com o mesmo contrato (`start`, `poll`, `metrics`) e registrar em `ADAPTERS`.
3. Incluir o novo valor na restrição da coluna `provider` de `social_accounts` e gravar esse valor nas novas conexões. O worker escolhe o adaptador pela conta, então contas antigas seguem no provedor até serem reconectadas.

## Não testado

Não há chave do provedor configurada, então a conexão, o upload e as métricas do TikTok foram escritos pela documentação e nunca rodaram contra a API real. O primeiro cliente conectado é o teste de verdade. Pontos de maior risco: o formato exato da resposta de status e de métricas, que a documentação mostra só em parte.

Fontes: [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started), [TikTok Content Sharing Guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines), [Upload-Post Connect API](https://docs.upload-post.com/api/connect-api/), [Upload-Post Upload Video](https://docs.upload-post.com/api/upload-video), [Upload-Post Upload Photo](https://docs.upload-post.com/api/upload-photo), [Upload-Post preços](https://www.upload-post.com/pricing).
