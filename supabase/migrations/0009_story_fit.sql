-- Story em 9:16: o publicador ajusta a imagem do story antes de enviar ao Instagram e guarda aqui o
-- endereco original. Preenchido = ja conferido (igual a media_url quando a imagem ja era 9:16). Migracao so aditiva.
alter table public.creatives add column if not exists fit_source text;
comment on column public.creatives.fit_source is 'Imagem original antes do ajuste do story para 9:16 (1080x1920). Igual a media_url quando a imagem ja era 9:16; nulo = ainda nao conferido.';
