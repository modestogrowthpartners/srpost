-- Login unificado da Meta (Facebook Login for Business): a conta do Instagram e alcancada pela Pagina do Facebook.
-- Guardamos o ID do usuario do Facebook (para os callbacks de desautorizacao e exclusao) e a Pagina vinculada.
alter table public.social_accounts
  add column if not exists fb_user_id text,
  add column if not exists page_id text,
  add column if not exists page_name text;
create index if not exists social_accounts_fb_user_idx on public.social_accounts (fb_user_id);
