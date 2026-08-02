-- ============================================================================
-- AISLAMIENTO MULTI-TENANT CONTRA UN POSTGRESQL REAL
--
-- La regla #1 del proyecto: un negocio JAMÁS puede ver ni tocar los datos de
-- otro. Hasta ahora solo estaba probada con simulacros; aquí se comprueba con
-- DOS negocios reales conviviendo en la misma base.
--
-- Un fallo aquí no es un bug: es un incidente de seguridad. Por eso cada
-- comprobación intenta ACTIVAMENTE cruzar la frontera y exige que la base lo
-- impida, en vez de limitarse a mirar que los datos propios estén bien.
--
-- Se corre sobre una base recién creada con bootstrap-supabase.sql + schema.sql.
-- ============================================================================

\set ON_ERROR_STOP on

do $$
declare
  v_a uuid;              -- negocio A
  v_b uuid;              -- negocio B
  v_producto_a uuid;
  v_producto_b uuid;
  v_categoria_a uuid;
  v_categoria_b uuid;
  v_producto_tmp uuid;
  v_pedidos_b integer;
  v_encolado boolean;
  v_ok boolean;
begin
  -- ── Dos negocios distintos, cada uno con lo suyo ─────────────────────────
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_bookings, takes_orders
  ) values (
    'aislamiento-a', 'Negocio A', 'tienda',
    'ycloud', '+593900001111', '+593900001111', true, true
  ) returning id into v_a;

  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_bookings, takes_orders
  ) values (
    'aislamiento-b', 'Negocio B', 'tienda',
    'ycloud', '+593900002222', '+593900002222', true, true
  ) returning id into v_b;

  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Producto de A', 10.00, 'disponible', true)
  returning id into v_producto_a;

  insert into products (business_id, name, price, stock, active)
  values (v_b, 'Producto de B', 99.00, 'disponible', true)
  returning id into v_producto_b;

  -- ── 1. DINERO: A no puede vender el producto de B ────────────────────────
  -- Si esto pasara, un negocio podría cobrar por el catálogo del vecino.
  begin
    perform public.create_order_with_items(
      v_a, '+593900009999', 'Cliente', 'pendiente', 0, 'USD',
      jsonb_build_array(jsonb_build_object(
        'product_id', v_producto_b, 'quantity', 1, 'unit_price', 99.00
      ))
    );
    raise exception 'FUGA: el negocio A pudo crear un pedido con el producto de B';
  exception when sqlstate '42501' then
    null;  -- rechazado como debe
  end;

  -- Lo mismo por el camino de las ventas. El alta manual se retiró el
  -- 2026-08-02, así que la frontera se comprueba donde ahora nace el dinero:
  -- nadie puede cobrarse el pedido ni la cita de otro negocio.
  declare
    v_pedido_a uuid;
    v_cita_a uuid;
  begin
    insert into orders (business_id, contact_phone, status, total)
    values (v_a, '+593900009999', 'completado', 50.00)
    returning id into v_pedido_a;

    if public.crear_venta_desde_pedido(v_b, v_pedido_a) is not null then
      raise exception 'FUGA: el negocio B se cobró un pedido del negocio A';
    end if;

    insert into bookings (
      business_id, contact_phone, service, price, booking_date, booking_time, status
    ) values (
      v_a, '+593900009999', 'Servicio', 30.00, current_date, '10:00', 'confirmed'
    ) returning id into v_cita_a;

    if public.crear_venta_desde_cita(v_b, v_cita_a) is not null then
      raise exception 'FUGA: el negocio B se cobró una cita del negocio A';
    end if;
  end;

  -- Con su propio producto sí funciona: la barrera no rompe el uso legítimo.
  perform public.create_order_with_items(
    v_a, '+593900009999', 'Cliente', 'pendiente', 0, 'USD',
    jsonb_build_array(jsonb_build_object(
      'product_id', v_producto_a, 'quantity', 1, 'unit_price', 10.00
    ))
  );

  -- ── 2. CATÁLOGO: la búsqueda semántica no cruza negocios ─────────────────
  if exists (
    select 1
    from public.match_products(
      array_fill(0.01::real, array[1536])::vector, v_a, 50
    ) as encontrado
    where encontrado.id = v_producto_b
  ) then
    raise exception 'FUGA: la búsqueda del negocio A devolvió un producto de B';
  end if;

  -- ── 3. COLA DE WEBHOOKS: el mismo mensaje en dos negocios no se pisa ──────
  -- Deduplicar por hash sin mirar el negocio haría que el mensaje de un cliente
  -- silenciara el de otro.
  v_encolado := public.enqueue_webhook_event(
    v_a, 'ycloud', repeat('a', 64), repeat('b', 64), '{"content":{"kind":"text"}}'::jsonb
  );
  if v_encolado is not true then
    raise exception 'El negocio A no pudo encolar su mensaje';
  end if;

  v_encolado := public.enqueue_webhook_event(
    v_b, 'ycloud', repeat('a', 64), repeat('b', 64), '{"content":{"kind":"text"}}'::jsonb
  );
  if v_encolado is not true then
    raise exception 'FUGA: el mensaje del negocio A bloqueó el del negocio B';
  end if;

  -- ── 4. ERRORES: la misma huella en dos negocios son dos registros ────────
  perform public.record_platform_error(
    v_a, 'canal', '503', 'Mismo error', '{}'::jsonb, repeat('c', 64)
  );
  perform public.record_platform_error(
    v_b, 'canal', '503', 'Mismo error', '{}'::jsonb, repeat('c', 64)
  );
  if (select count(*) from platform_errors where fingerprint = repeat('c', 64)) <> 2 then
    raise exception 'FUGA: el error de un negocio se mezcló con el de otro';
  end if;

  -- ── 5. RESERVAS: la agenda de A no ocupa la de B ─────────────────────────
  update business_schedule
  set is_active = true, open_time = '08:00', close_time = '20:00'
  where business_id in (v_a, v_b)
    and day_of_week = extract(dow from current_date + 1)::int;

  perform public.create_booking_if_available(
    v_a, '+593900009999', 'Cliente', 'Servicio',
    (current_date + 1)::date, '10:00'::time, 60
  );
  -- B debe poder reservar EXACTAMENTE el mismo hueco: son agendas distintas.
  perform public.create_booking_if_available(
    v_b, '+593900008888', 'Otro cliente', 'Servicio',
    (current_date + 1)::date, '10:00'::time, 60
  );
  if (select count(*) from bookings where business_id = v_b) <> 1 then
    raise exception 'FUGA: la reserva del negocio A bloqueó la agenda de B';
  end if;

  -- ── 6. CATÁLOGO: el de A no se engancha al de B ──────────────────────────
  --
  -- `product_variants` lleva business_id Y product_id; `products` lleva
  -- business_id Y category_id. Con una foránea de una sola columna el negocio
  -- salía del JWT pero el otro id viajaba en la petición, así que la frontera
  -- se cruzaba mandando un uuid ajeno. Las rutas lo comprueban, pero eso
  -- dependía de que quien escriba la próxima ruta se acordara. Aquí se exige
  -- que lo impida la BASE.
  insert into product_categories (business_id, name)
  values (v_b, 'Categoría de B')
  returning id into v_categoria_b;

  begin
    insert into product_variants (business_id, product_id, name, price)
    values (v_a, v_producto_b, 'Familiar', 1.00);
    raise exception 'FUGA: el negocio A pudo colgar una variante del producto de B';
  exception when foreign_key_violation then
    null;  -- correcto: la base rechaza la pareja (producto, negocio)
  end;

  begin
    update products set category_id = v_categoria_b where id = v_producto_a;
    raise exception 'FUGA: el negocio A pudo meter su producto en la categoría de B';
  exception when foreign_key_violation then
    null;
  end;

  -- Y el uso legítimo sigue funcionando: una cerradura que también deja fuera
  -- al dueño no sirve de nada.
  insert into product_categories (business_id, name)
  values (v_a, 'Pizzas de A')
  returning id into v_categoria_a;

  update products set category_id = v_categoria_a where id = v_producto_a;

  insert into product_variants (business_id, product_id, name, price)
  values (v_a, v_producto_a, 'Familiar', 14.00);

  -- Borrar la categoría deja el producto suelto y NO revienta. Importa porque
  -- la foránea compuesta anula solo `category_id`: sin nombrar la columna,
  -- PostgreSQL intentaría anular también `business_id`, que es NOT NULL.
  delete from product_categories where id = v_categoria_a;
  select category_id is null into v_ok from products where id = v_producto_a;
  if v_ok is not true then
    raise exception 'Borrar una categoría dejó el producto apuntando a la nada';
  end if;

  -- Borrar un producto se lleva sus variantes. Se usa uno DESECHABLE: el de A
  -- tiene que seguir vivo para la comprobación de cascada que viene ahora.
  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Producto desechable de A', 5.00, 'disponible', true)
  returning id into v_producto_tmp;

  insert into product_variants (business_id, product_id, name, price)
  values (v_a, v_producto_tmp, 'Único', 5.00);

  delete from products where id = v_producto_tmp;
  if exists (select 1 from product_variants where product_id = v_producto_tmp) then
    raise exception 'Las variantes sobrevivieron al producto que las contenía';
  end if;

  -- ── 7. BORRADO EN CASCADA: se lleva lo suyo y solo lo suyo ───────────────
  select count(*) into v_pedidos_b from orders where business_id = v_b;
  delete from businesses where id = v_a;

  if exists (select 1 from products where business_id = v_a) then
    raise exception 'Borrar el negocio A dejó sus productos huérfanos';
  end if;
  if exists (select 1 from orders where business_id = v_a) then
    raise exception 'Borrar el negocio A dejó sus pedidos huérfanos';
  end if;
  if exists (select 1 from platform_errors where business_id = v_a) then
    raise exception 'Borrar el negocio A dejó sus errores huérfanos';
  end if;

  -- Y lo más importante: no se llevó nada del vecino.
  if not exists (select 1 from products where id = v_producto_b) then
    raise exception 'FUGA GRAVE: borrar el negocio A eliminó el producto de B';
  end if;
  if (select count(*) from orders where business_id = v_b) <> v_pedidos_b then
    raise exception 'FUGA GRAVE: borrar el negocio A alteró los pedidos de B';
  end if;
  if not exists (select 1 from bookings where business_id = v_b) then
    raise exception 'FUGA GRAVE: borrar el negocio A eliminó la reserva de B';
  end if;

  -- ── 8. RLS activa en todas las tablas de negocio ─────────────────────────
  select bool_and(c.relrowsecurity) into v_ok
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r';
  if v_ok is not true then
    raise exception 'Hay tablas sin RLS habilitada';
  end if;

  -- ── Limpieza ─────────────────────────────────────────────────────────────
  delete from businesses where id = v_b;

  raise notice 'AISLAMIENTO MULTI-TENANT: ninguna frontera se pudo cruzar';
end;
$$;
