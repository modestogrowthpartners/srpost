# Entrada do agente: como mandar criativos para a fila de um cliente

O agente de IA (ou o n8n) envia o criativo já pronto: mídia, legenda, hashtags, link e opções. O criativo entra na fila do cliente no portal. O cliente decide sim ou não, e o sim publica com tudo o que foi enviado.

## Chave por cliente

Cada cliente tem a própria chave. Com ela o agente só consegue enviar para a fila daquele cliente, mesmo que erre o identificador.

1. Painel do time, página do cliente, bloco **Entrada do agente (chave deste cliente)**.
2. Clique em **Gerar chave do cliente**. A chave começa com `srp_cli_` e aparece uma única vez.
3. Guarde a chave no cofre de segredos do agente. Para trocar, gere outra e revogue a antiga no mesmo bloco.

Todas as chamadas levam a chave no cabeçalho `x-api-key`.

Endereço base: `https://qmmhqhebxynycjxqxber.supabase.co/functions/v1/api/ingest`

Também existe a chave geral de ingestão (`srp_ing_`, criada em Configuração). Ela envia para qualquer cliente e exige `client_slug` no corpo. Prefira a chave por cliente.

## 1. Conferir a chave

```bash
curl -sS "$BASE/me" -H "x-api-key: $CHAVE"
```

Devolve o cliente da chave, as redes do agente, as contas conectadas e o ritmo de publicação em vigor.

## 2. Enviar a mídia

Duas formas:

- **Arquivo hospedado pelo agente:** informe `media_url` (https, público) direto no criativo.
- **Upload para o Sr. Post:** peça um endereço de upload e envie o arquivo.

```bash
curl -sS -X POST "$BASE/upload-url" -H "x-api-key: $CHAVE" -H "content-type: application/json" \
  -d '{"filename":"reel-01.mp4","content_type":"video/mp4"}'
```

A resposta traz `signed_url`, `path` e `content_type`. Envie o arquivo com `PUT` para `signed_url` (cabeçalho `content-type` igual ao informado) e use o `path` como `media_path` no criativo.

Tipos aceitos: `video/mp4`, `video/quicktime`, `image/jpeg`, `image/png`, `image/webp`, até 50 MB. O Instagram só publica imagem em JPEG pela API: prefira JPEG.

## 3. Enviar o criativo

```bash
curl -sS -X POST "$BASE/creatives" -H "x-api-key: $CHAVE" -H "content-type: application/json" -d '{
  "items": [{
    "external_ref": "campanha-natal-reel-01",
    "media_url": "https://cdn.exemplo.com/reel-01.mp4",
    "format": "reel",
    "title": "Promoção de Natal",
    "caption": "Últimos dias da promoção de Natal.",
    "hashtags": "#natal #promocao",
    "link": "https://loja.exemplo.com/natal?utm_source=instagram&utm_medium=social",
    "platforms": ["instagram", "tiktok"],
    "suggested_at": "2026-12-20T15:00:00-03:00",
    "location_id": "1234567890",
    "location_name": "Loja Centro",
    "ai_generated": true,
    "options": { "story": true, "caption": true, "music": false, "location": true }
  }]
}'
```

Até 50 criativos por chamada. Resposta: `created` (com o `id` de cada criativo e as opções gravadas) e `skipped_duplicates`.

### Campos

| Campo | Obrigatório | Descrição |
| --- | --- | --- |
| `media_url` ou `media_path` | sim (mídia única) | Endereço público https, ou o `path` devolvido pelo upload |
| `media` | sim (carrossel) | Lista de 2 a 10 itens, cada um com `media_url` ou `media_path` |
| `format` | não | `reel` (vídeo), `feed` (imagem ou carrossel) ou `story`. Padrão: `reel` para vídeo, `feed` para imagem |
| `kind` | não | `video` ou `image`. Deduzido da extensão quando ausente |
| `title` | não | Título interno, aparece no cartão do cliente |
| `caption` | não | Legenda |
| `hashtags` | não | Até 30 hashtags |
| `link` | não | Link completo (com `https://`). Vai no fim da legenda, como texto |
| `platforms` | não | `["instagram"]`, `["tiktok"]` ou as duas. Padrão: as redes do agente do cliente |
| `suggested_at` | não | Data e hora sugeridas, ISO 8601. Sem ela, o post vai no próximo horário livre do agente |
| `location_id` | não | ID numérico da Página do Facebook do local (Instagram) |
| `location_name` | não | Nome do local, mostrado ao cliente |
| `audio_name` | não | Só Reel: renomeia o áudio original |
| `ai_generated` | não | `true` marca o conteúdo como gerado por IA nas redes |
| `external_ref` | não | Identificador do agente. Reenviar o mesmo valor não duplica o criativo |
| `revision_of` | não | `id` do criativo que o cliente pediu para ajustar: a nova versão o substitui |
| `options` | não | Ver abaixo |

Legenda + link + hashtags não podem passar de 2.200 caracteres.

### Opções

O cliente vê as quatro opções no cartão e pode mudar antes de aprovar. O que a rede não aceita fica desligado, sem erro, e aparece travado com o motivo.

| Opção | Padrão | O que faz | Onde não vale |
| --- | --- | --- | --- |
| `story` | `false` | Publica também no story do Instagram, depois do post principal | TikTok (não tem story pela API) e criativo que já é story. O story sai sem legenda, link, local e figurinhas |
| `caption` | `true` | Publica com legenda, link e hashtags | Story: a API do Instagram não aceita legenda em story |
| `music` | `false` | TikTok em post de foto ou carrossel: música automática do provedor | Instagram (a API não escolhe música da biblioteca) e vídeo (a música precisa estar no arquivo) |
| `location` | `true` | Marca o local informado em `location_id` | Sem `location_id`, em story e no TikTok |

Limites confirmados na documentação oficial em novembro de 2026:

- Instagram: a API de publicação não aceita figurinhas em story (link, enquete, local) e não tem parâmetro para escolher música. `audio_name` só renomeia o áudio original do Reel.
- Links na legenda aparecem como texto, sem clique. Isso é comportamento conhecido do Instagram e do TikTok, não um item da documentação da API.
- TikTok pelo provedor: o provedor documenta música da biblioteca comercial (`tiktok_music_id`) e local (`tiktok_location_id`), mas dependem de capacidades da conta e de um seletor de faixa e de local que o Sr. Post ainda não tem. Por isso aparecem como indisponíveis. **A VERIFICAR** quando a chave do provedor estiver ativa.

## 4. Acompanhar o que aconteceu

```bash
curl -sS "$BASE/creatives?external_ref=campanha-natal-reel-01" -H "x-api-key: $CHAVE"
```

Sem filtro, devolve os 100 criativos mais recentes. Filtros: `external_ref` e `status` (`pending`, `approved`, `rejected`, `adjust`, `replaced`).

Para cada criativo:

- `status`: decisão do cliente.
- `adjust_request`: o que o cliente pediu para mudar, quando o status é `adjust`. O agente gera a nova versão e reenvia com `revision_of`.
- `options`: como ficaram as opções depois da decisão do cliente.
- `posts`: uma linha por publicação (rede, `placement` igual a `main` ou `story`, status, horário, link do post e motivo da falha, se houver).

## Erros

| HTTP | `error` | Significado |
| --- | --- | --- |
| 401 | `missing_key`, `invalid_key` | Chave ausente, errada ou revogada |
| 403 | `wrong_client` | A chave é de outro cliente |
| 404 | `client_not_found` | `client_slug` inexistente (chave geral) |
| 400 | `bad_media`, `bad_format`, `bad_carousel`, `bad_link`, `bad_location`, `bad_date`, `caption_too_long`, `too_many_hashtags`, `too_many`, `no_items` | Problema no criativo; a mensagem diz qual item |

## Ritmo de publicação

O envio não tem limite além de 50 criativos por chamada. Quem controla o ritmo é o publicador, por conta:

- no máximo um post por conta a cada ciclo de 1 minuto;
- intervalo mínimo entre publicações da mesma conta (padrão: 15 minutos);
- teto de publicações por conta em 24 horas (padrão: 12);
- antes de cada publicação no Instagram, consulta o limite que a própria Meta informa para a conta (na consulta de 15/11/2026, 100 em 24 horas).

O intervalo e o teto são regra do Sr. Post, ajustáveis em Configuração. A Meta só documenta o limite de 24 horas. Depois de uma recusa por suspeita de spam (código 4, subcódigo 2207051), a conta inteira entra em pausa de 1 hora, que dobra a cada nova recusa, até 24 horas.
