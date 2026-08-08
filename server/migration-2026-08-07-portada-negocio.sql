-- ═══════════════════════════════════════════════════════════════════════════
-- PORTADA DEL NEGOCIO — la imagen a sangre de su mini app
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La pantalla 2 del diagrama abre con una foto del local a todo lo ancho y el
-- logo encima. Hasta ahora solo existía `logo_url`, así que la cabecera era un
-- bloque de tinta: correcto, pero no es lo que el dueño aprobó.
--
-- Va junto a `logo_url` y `brand_color`: son las tres cosas que hacen que la
-- tienda se vea del negocio y no de la plataforma.
--
-- La imagen NO se guarda aquí: se sube a Cloudinary desde el panel (que ya lo
-- hace para el catálogo y para el logo) y lo que se guarda es la URL que
-- devuelve. Por eso el CHECK exige https: esa URL acaba dentro de un <img> de
-- una app PÚBLICA, y un `javascript:` o un http ahí no tienen nada que hacer.
-- Es el mismo criterio de `businesses_logo_check`, y a propósito: dos reglas
-- distintas para dos imágenes que acaban en el mismo sitio se desincronizan.
--
-- Idempotente. Aplicar con `npm run migrate`.

alter table public.businesses
  add column if not exists cover_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_cover_check'
  ) then
    alter table public.businesses add constraint businesses_cover_check check (
      cover_url is null or cover_url ~ '^https://'
    );
  end if;
end;
$$;

comment on column public.businesses.cover_url is
  'Imagen de portada de la mini app, subida a Cloudinary. Solo https.';
