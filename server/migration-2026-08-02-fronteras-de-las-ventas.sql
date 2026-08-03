-- ═══════════════════════════════════════════════════════════════════════════
-- CIERRA LAS FRONTERAS QUE ABRIÓ EL ESTÁNDAR DE VENTAS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Encontradas el 2026-08-02 por `npm run verify:schema`, que NO corre en el CI
-- —solo en local con Docker— y por eso el CI estuvo verde todo el día mientras
-- se abrían. Las cuatro se introdujeron ese mismo día:
--
--   sales(order_id)            → orders
--   sales(booking_id)          → bookings
--   sales(lodging_request_id)  → lodging_requests
--   bookings(product_id)       → products
--
-- El problema: la clave foránea comprueba que la fila EXISTA, no de quién es.
-- Con una simple, una venta del negocio A podía apuntar al pedido del negocio
-- B. Las funciones `crear_venta_desde_*` ya lo impiden —reciben el negocio y
-- filtran—, pero eso depende de que nadie escriba nunca por otro camino. La
-- regla #1 del proyecto es que lo impida la BASE.
--
-- La solución es la misma que ya usa `product_variants`: clave foránea
-- COMPUESTA sobre (id, business_id). Para que PostgreSQL la admita, el destino
-- necesita un índice único sobre ese par.
--
-- ⚠️ Si hubiera filas cruzadas, el ALTER falla. Es lo correcto: significaría
-- que el agujero se usó. Con la base en cero no hay nada que migrar.
--
-- Idempotente. Aplicar con `npm run migrate`.

-- ── 1. Los destinos necesitan su índice único (id, business_id) ───────────
create unique index if not exists uq_orders_id_business
  on public.orders (id, business_id);
create unique index if not exists uq_bookings_id_business
  on public.bookings (id, business_id);
create unique index if not exists uq_lodging_requests_id_business
  on public.lodging_requests (id, business_id);

-- ── 2. Las ventas solo pueden apuntar a algo de SU negocio ────────────────
do $$
begin
  -- La foránea simple se retira: dejarla viva permitiría el cruce igual.
  alter table public.sales drop constraint if exists sales_order_id_fkey;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales'::regclass and conname = 'fk_sales_pedido_del_negocio'
  ) then
    alter table public.sales
      add constraint fk_sales_pedido_del_negocio
      foreign key (order_id, business_id)
      references public.orders (id, business_id) on delete set null;
  end if;

  alter table public.sales drop constraint if exists sales_booking_id_fkey;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales'::regclass and conname = 'fk_sales_cita_del_negocio'
  ) then
    alter table public.sales
      add constraint fk_sales_cita_del_negocio
      foreign key (booking_id, business_id)
      references public.bookings (id, business_id) on delete set null;
  end if;

  alter table public.sales drop constraint if exists sales_lodging_request_id_fkey;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales'::regclass and conname = 'fk_sales_estadia_del_negocio'
  ) then
    alter table public.sales
      add constraint fk_sales_estadia_del_negocio
      foreign key (lodging_request_id, business_id)
      references public.lodging_requests (id, business_id) on delete set null;
  end if;
end;
$$;

-- ── 3. La cita ya tenía su foránea compuesta, pero la simple seguía viva ──
-- `add column ... references products(id)` la creó sola, y mientras exista el
-- cruce sigue siendo posible por ella.
alter table public.bookings drop constraint if exists bookings_product_id_fkey;
