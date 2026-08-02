-- ═══════════════════════════════════════════════════════════════════════════
-- AISLAMIENTO DEL CATÁLOGO — que lo impida la BASE, no solo el código
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El problema: `product_variants` lleva `business_id` Y `product_id`, pero la
-- clave foránea de `product_id` apunta a `products` SIN mirar de quién es.
-- Igual con `products.category_id` → `product_categories`. El negocio sale del
-- JWT, pero el id del producto o de la categoría viaja en el cuerpo de la
-- petición: mandando un uuid ajeno se podía colgar una variante —con su
-- precio— del catálogo de otro negocio.
--
-- Las rutas ya lo comprueban (PR #132). Esto es la segunda cerradura: hasta
-- ahora la protección dependía de que quien escriba la próxima ruta se
-- acordara, y eso ya nos mordió antes. Con esto la base RECHAZA la fila.
--
-- Cómo: una clave foránea COMPUESTA. En vez de "este producto existe", la
-- condición pasa a ser "este producto existe Y es de este negocio". Para que
-- PostgreSQL lo admita, el destino necesita un índice único sobre el par.
--
-- ⚠️ Si la base tiene filas cruzadas, el ALTER falla. Es lo correcto: significa
-- que el agujero se usó. El primer bloque las lista ANTES de intentar nada,
-- para que el error no llegue de sorpresa.

-- ── 1. ¿Hay ya filas cruzadas? ─────────────────────────────────────────────
do $$
declare
  variantes_cruzadas integer;
  productos_cruzados integer;
begin
  select count(*) into variantes_cruzadas
  from public.product_variants v
  join public.products p on p.id = v.product_id
  where p.business_id is distinct from v.business_id;

  select count(*) into productos_cruzados
  from public.products p
  join public.product_categories c on c.id = p.category_id
  where c.business_id is distinct from p.business_id;

  if variantes_cruzadas > 0 or productos_cruzados > 0 then
    raise exception
      'HAY DATOS CRUZADOS ENTRE NEGOCIOS: % variantes y % productos. Revísalos a mano ANTES de aplicar esta migración.',
      variantes_cruzadas, productos_cruzados;
  end if;

  raise notice 'Sin datos cruzados: se puede cerrar la puerta.';
end $$;

-- ── 2. Índices únicos sobre el par (id, business_id) ───────────────────────
-- Redundantes con la clave primaria en lo que toca a unicidad, pero es lo que
-- PostgreSQL exige para poder apuntar a la pareja desde otra tabla.
create unique index if not exists uq_products_id_business
  on public.products (id, business_id);

create unique index if not exists uq_product_categories_id_business
  on public.product_categories (id, business_id);

-- ── 3. Variantes: el producto tiene que ser del MISMO negocio ──────────────
do $$
begin
  -- Fuera la foránea de una sola columna: la compuesta la reemplaza y dejar
  -- las dos solo confunde a quien lea el esquema dentro de un año.
  if exists (
    select 1 from pg_constraint
    where conname = 'product_variants_product_id_fkey'
      and conrelid = 'public.product_variants'::regclass
  ) then
    alter table public.product_variants drop constraint product_variants_product_id_fkey;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_product_variants_producto_del_negocio'
      and conrelid = 'public.product_variants'::regclass
  ) then
    alter table public.product_variants
      add constraint fk_product_variants_producto_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id)
      on delete cascade;
  end if;
end $$;

-- ── 4. Productos: la categoría tiene que ser del MISMO negocio ─────────────
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'products_category_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products drop constraint products_category_id_fkey;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'fk_products_categoria_del_negocio'
      and conrelid = 'public.products'::regclass
  ) then
    -- `set null (category_id)` y no `set null` a secas: sin nombrar la columna,
    -- PostgreSQL intentaría anular también `business_id`, que es NOT NULL, y
    -- borrar una categoría reventaría. Necesita PostgreSQL 15 o superior.
    alter table public.products
      add constraint fk_products_categoria_del_negocio
      foreign key (category_id, business_id)
      references public.product_categories (id, business_id)
      on delete set null (category_id);
  end if;
end $$;

do $$
begin
  raise notice 'AISLAMIENTO DEL CATÁLOGO: la base ya rechaza variantes y categorías de otro negocio.';
end $$;
