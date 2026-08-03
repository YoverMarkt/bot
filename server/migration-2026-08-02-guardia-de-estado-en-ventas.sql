-- ============================================================================
-- LAS FUNCIONES DE VENTA COMPRUEBAN EL ESTADO DE SU ORIGEN
--
-- `crear_venta_desde_pedido` y `crear_venta_desde_cita` comprobaban dos cosas
-- —que el origen fuera de ESTE negocio, y que no hubiera ya una venta— pero no
-- el ESTADO del origen. Verificado contra PostgreSQL real el 2026-08-02:
--
--   ⚠️ crear_venta_desde_pedido cobró un pedido en estado "cancelado"
--
-- Toda la protección vivía en los llamadores: `set_order_status` solo llama al
-- pasar a 'completado', y `set_booking_status` al pasar a 'attended'. Eso hoy
-- es cierto, y por eso el fallo estaba latente — ninguna ruta del servidor
-- llama a estas funciones directamente.
--
-- Pero son SECURITY DEFINER y están concedidas a `service_role`, que es
-- exactamente el rol con el que el servidor habla con Supabase. Un `db.rpc()`
-- distraído facturaría un pedido cancelado, y el dinero es lo único que no
-- puede depender de que el llamador se porte bien.
--
-- `crear_venta_desde_estadia` ya lo hacía así desde el principio:
--
--   -- Solo cuenta lo confirmado. Una solicitud pendiente o rechazada no es
--   -- dinero, igual que un pedido sin entregar.
--   if v_request.status is distinct from 'confirmed' then return null; end if;
--
-- Esto no añade una regla nueva: pone a las otras dos al día con la que ya
-- existía. No cambia ningún comportamiento actual — los llamadores solo
-- llaman en el estado correcto.
--
-- Idempotente: `create or replace`. No toca datos.
-- ============================================================================

create or replace function public.crear_venta_desde_pedido(
  p_business_id uuid,
  p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_sale_id uuid;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where order_id = p_order_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo entregado. Un pedido pendiente o cancelado no es dinero.
  -- Hoy quien decide es `set_order_status`, que solo llama aquí al pasar a
  -- 'completado' — pero esta función es SECURITY DEFINER y está concedida a
  -- service_role, así que un `db.rpc()` distraído facturaría un pedido
  -- cancelado. La misma guardia que ya tenía `crear_venta_desde_estadia`.
  if v_order.status is distinct from 'completado' then
    return null;
  end if;

  insert into public.sales (
    business_id, order_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_order_id,
    -- 'mostrador' no es el teléfono de nadie: la venta va sin contacto.
    nullif(v_order.contact_phone, 'mostrador'),
    v_order.contact_name,
    v_order.total, 'completada',
    case
      when v_order.source = 'storefront' then 'tienda'
      when v_order.source = 'manual' then 'mostrador'
      else 'bot'
    end,
    now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_sale_id, p_business_id, oi.product_id,
    oi.product_name || coalesce(' (' || oi.variant_name || ')', ''),
    oi.quantity, oi.unit_price, oi.line_total
  from public.order_items oi
  where oi.order_id = p_order_id and oi.business_id = p_business_id;

  return v_sale_id;
end;
$$;

create or replace function public.crear_venta_desde_cita(
  p_business_id uuid,
  p_booking_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booking public.bookings%rowtype;
  v_sale_id uuid;
  v_precio numeric(10,2);
  v_nombre text;
begin
  select * into v_booking
  from public.bookings
  where id = p_booking_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where booking_id = p_booking_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo atendido. Una cita pendiente, cancelada o a la que no vino
  -- nadie no es dinero. Igual que en pedidos y estadías: hoy quien decide es
  -- `set_booking_status`, pero esta función está concedida a service_role y no
  -- puede depender solo de su llamador.
  if v_booking.status is distinct from 'attended' then
    return null;
  end if;

  -- Sin precio no hay venta que registrar, y no es un error: una cita puede
  -- ser una consulta gratuita o el negocio puede cobrar aparte. Se atiende
  -- igual, simplemente no suma dinero.
  v_precio := coalesce(v_booking.price, 0);
  if v_precio <= 0 then
    return null;
  end if;

  v_nombre := coalesce(nullif(btrim(v_booking.service), ''), 'Servicio');

  insert into public.sales (
    business_id, booking_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_booking_id, v_booking.contact_phone, v_booking.contact_name,
    v_precio, 'completada', 'cita', now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  ) values (
    v_sale_id, p_business_id, v_booking.product_id, v_nombre, 1, v_precio, v_precio
  );

  return v_sale_id;
end;
$$;

-- Los permisos se rehacen: `create or replace` conserva los del original, pero
-- dejarlo explícito evita que una futura firma nueva nazca abierta.
revoke all on function public.crear_venta_desde_pedido(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_pedido(uuid, uuid) to service_role;
revoke all on function public.crear_venta_desde_cita(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_cita(uuid, uuid) to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
-- Se ejercita de verdad: un pedido cancelado y una cita sin atender NO pueden
-- generar venta, y el camino legítimo tiene que seguir funcionando.
do $$
declare
  v_b uuid; v_pedido uuid; v_cita uuid;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_bookings, takes_orders
  ) values (
    'guardia-estado-tmp', 'Guardia', 'tienda', 'ycloud',
    '+593900555001', '+593900555001', true, true
  ) returning id into v_b;

  insert into orders (business_id, contact_phone, status, total)
  values (v_b, '+593900555002', 'cancelado', 20.00) returning id into v_pedido;
  if public.crear_venta_desde_pedido(v_b, v_pedido) is not null then
    raise exception 'Un pedido cancelado generó venta';
  end if;

  insert into bookings (
    business_id, contact_phone, service, price, booking_date, booking_time, status
  ) values (
    v_b, '+593900555002', 'Corte', 20.00, current_date, '10:00', 'cancelled'
  ) returning id into v_cita;
  if public.crear_venta_desde_cita(v_b, v_cita) is not null then
    raise exception 'Una cita cancelada generó venta';
  end if;

  -- El camino legítimo sigue vivo: una cerradura que deja fuera al dueño no sirve.
  update orders set status = 'completado' where id = v_pedido;
  if public.crear_venta_desde_pedido(v_b, v_pedido) is null then
    raise exception 'Un pedido completado NO generó su venta';
  end if;

  update bookings set status = 'attended' where id = v_cita;
  if public.crear_venta_desde_cita(v_b, v_cita) is null then
    raise exception 'Una cita atendida NO generó su venta';
  end if;

  delete from businesses where id = v_b;
  raise notice 'GUARDIA DE ESTADO: pedido y cita solo se cobran en su estado';
end;
$$;
