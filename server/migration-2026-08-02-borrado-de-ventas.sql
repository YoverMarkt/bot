-- ============================================================================
-- BORRAR UN PEDIDO, UNA CITA O UNA ESTADÍA QUE YA ES VENTA
--
-- Las tres foráneas que cerraron las fronteras entre negocios el 2026-08-02
-- (migration-2026-08-02-fronteras-de-las-ventas.sql) se escribieron con
-- `on delete set null` a secas. Sin nombrar la columna, PostgreSQL anula TODAS
-- las de la pareja — incluida `business_id`, que es NOT NULL en `sales`.
--
-- Resultado: borrar un pedido entregado, una cita atendida o una estadía
-- confirmada reventaba con 23502:
--
--   null value in column "business_id" of relation "sales"
--   violates not-null constraint
--
-- Hoy no hay ninguna ruta que borre pedidos ni citas, así que el fallo estaba
-- latente — el mismo caso que `product_variants`: el agujero existía, pero no
-- había puerta. Bloqueaba ya cualquier limpieza o mantenimiento de datos, y
-- habría explotado el día que se construyera «borrar pedido».
--
-- ⚠️ La lección estaba escrita en este mismo esquema desde el
-- 2026-08-02, en la foránea de `products.category_id`:
--
--     `set null (category_id)` y no `set null` a secas: sin nombrar la
--     columna PostgreSQL anularía también `business_id`, que es NOT NULL.
--
-- Se aplicó allí y no se aplicó aquí. Por eso este arreglo viene acompañado de
-- una comprobación en `verificar-aislamiento.sql` que BORRA de verdad: la
-- forma de la foránea ya la vigilaba `verificar-fronteras.sql` y aun así pasó,
-- porque una foránea compuesta correcta puede tener una acción de borrado rota.
--
-- Necesita PostgreSQL 15 o superior (Supabase lo cumple).
-- Idempotente: se puede correr las veces que haga falta.
-- ============================================================================

-- Las foráneas se recrean SIEMPRE, sin `if not exists`: en las bases donde ya
-- existen es justamente donde están mal.
do $$
begin
  -- ── Pedido ────────────────────────────────────────────────────────────────
  alter table public.sales drop constraint if exists sales_order_id_fkey;
  alter table public.sales drop constraint if exists fk_sales_pedido_del_negocio;
  alter table public.sales
    add constraint fk_sales_pedido_del_negocio
    foreign key (order_id, business_id)
    references public.orders (id, business_id)
    on delete set null (order_id);

  -- ── Cita ──────────────────────────────────────────────────────────────────
  alter table public.sales drop constraint if exists sales_booking_id_fkey;
  alter table public.sales drop constraint if exists fk_sales_cita_del_negocio;
  alter table public.sales
    add constraint fk_sales_cita_del_negocio
    foreign key (booking_id, business_id)
    references public.bookings (id, business_id)
    on delete set null (booking_id);

  -- ── Estadía ───────────────────────────────────────────────────────────────
  alter table public.sales drop constraint if exists sales_lodging_request_id_fkey;
  alter table public.sales drop constraint if exists fk_sales_estadia_del_negocio;
  alter table public.sales
    add constraint fk_sales_estadia_del_negocio
    foreign key (lodging_request_id, business_id)
    references public.lodging_requests (id, business_id)
    on delete set null (lodging_request_id);
end;
$$;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
-- Que la migración se aplique no basta: se exige que las tres acciones nombren
-- su columna. Si alguna vuelve a quedar en `SET NULL` a secas, esto lo para
-- aquí y no meses después.
do $$
declare
  v_rotas text;
begin
  select string_agg(conname, ', ')
  into v_rotas
  from pg_constraint
  where conrelid = 'public.sales'::regclass
    and contype = 'f'
    and conname in (
      'fk_sales_pedido_del_negocio',
      'fk_sales_cita_del_negocio',
      'fk_sales_estadia_del_negocio'
    )
    -- `SET NULL (columna)` aparece con paréntesis; `SET NULL` a secas, no.
    and pg_get_constraintdef(oid) !~ 'ON DELETE SET NULL \(';

  if v_rotas is not null then
    raise exception
      'Estas foráneas siguen anulando business_id al borrar: %', v_rotas;
  end if;

  raise notice 'BORRADO DE VENTAS: las tres foráneas nombran su columna';
end;
$$;
