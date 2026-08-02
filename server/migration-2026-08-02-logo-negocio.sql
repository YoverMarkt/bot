-- ═══════════════════════════════════════════════════════════════════════════
-- LOGO DEL NEGOCIO — se sube en el panel y se ve en su mini app
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Va junto al color de marca: son las dos cosas que hacen que la tienda se vea
-- del negocio y no de la plataforma.
--
-- La imagen NO se guarda aquí: se sube a Cloudinary desde el panel (que ya lo
-- hace para el catálogo) y lo que se guarda es la URL que devuelve Cloudinary.
-- Por eso el CHECK exige https: esa URL acaba dentro de un <img> de una app
-- pública, y un `javascript:` o un http ahí no tienen nada que hacer.
--
-- Idempotente. Aplicar con `npm run migrate`.

alter table public.businesses
  add column if not exists logo_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_logo_check'
  ) then
    alter table public.businesses add constraint businesses_logo_check check (
      logo_url is null or logo_url ~ '^https://'
    );
  end if;
end;
$$;
