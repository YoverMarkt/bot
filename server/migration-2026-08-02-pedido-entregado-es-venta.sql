-- ═══════════════════════════════════════════════════════════════════════════
-- UN PEDIDO ENTREGADO ES UNA VENTA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El agujero que cierra: TODOS los reportes del dueño (ventas, dashboard,
-- clientes, productos más vendidos, clientes perdidos) leen la tabla `sales`,
-- que hasta hoy solo se llenaba con el botón «Registrar venta» del panel. Un
-- pedido de la tienda o del bot podía entregarse y NO aparecía en ningún
-- reporte. El negocio vendía y sus números decían que no.
--
-- El estándar que se establece: cada tipo de negocio tiene su bandeja donde
-- atiende (Pedidos, y más adelante Citas y Hospedaje), pero todas desembocan
-- en el MISMO sitio, `sales`. Así los reportes tienen una sola fuente de
-- verdad y no hay que tocarlos nunca más al añadir un flujo nuevo.
--
-- Cuándo cuenta: al marcarlo ENTREGADO, que es cuando el dinero está de
-- verdad en el negocio. Un pedido rechazado o cancelado no ensucia el reporte.
--
-- Idempotente en dos sentidos: el archivo se puede correr varias veces, y un
-- pedido no puede generar dos ventas (lo impide un índice único).

-- ── 1. La venta sabe de qué pedido salió ──────────────────────────────────
alter table public.sales
  add column if not exists order_id uuid references public.orders(id) on delete set null;

-- Un pedido, una venta como máximo. No es solo higiene: es lo que hace que
-- marcar «entregado» dos veces —o reintentar tras un fallo de red— no duplique
-- el dinero del reporte.
create unique index if not exists uq_sales_order
  on public.sales (order_id) where order_id is not null;

create index if not exists idx_sales_biz_order
  on public.sales (business_id, order_id);

-- ── 2. La conversión, en una función reutilizable ─────────────────────────
-- Vive aparte para que la usen los dos caminos que cierran un pedido: marcarlo
-- entregado desde la bandeja, y el pedido de mostrador que nace ya entregado.
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

  -- Ya tenía venta: no se duplica el dinero.
  select id into v_sale_id
  from public.sales
  where order_id = p_order_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- El total es el del pedido e incluye el envío: es el dinero que entró al
  -- negocio. Los ítems son solo productos, así que «lo más vendido» no se
  -- ensucia con una línea de envío que nadie pidió.
  insert into public.sales (
    business_id, order_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_order_id, v_order.contact_phone, v_order.contact_name,
    v_order.total, 'completada',
    case when v_order.source = 'storefront' then 'tienda' else 'bot' end,
    now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_sale_id, p_business_id, oi.product_id,
    -- El nombre se congela con su variante: «Pizza Pepperoni (Mediana)» es lo
    -- que el dueño reconoce al leer su reporte tres meses después.
    oi.product_name || coalesce(' (' || oi.variant_name || ')', ''),
    oi.quantity, oi.unit_price, oi.line_total
  from public.order_items oi
  where oi.order_id = p_order_id and oi.business_id = p_business_id;

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_pedido(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_pedido(uuid, uuid) to service_role;

-- ── 3. Marcar entregado registra la venta, en la misma transacción ────────
-- Va DENTRO de set_order_status y no en un disparador a propósito: en este
-- proyecto un trigger mal colocado ya tumbó el alta de clientes (2026-08-02).
-- Aquí el camino es explícito y se lee de una vez.
create or replace function public.set_order_status(
  p_business_id uuid,
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if p_status not in (
    'confirmado', 'preparacion', 'en_camino', 'completado', 'cancelado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'order', null);
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
  end if;

  -- Un pedido que el cliente retira en el local (o consume en sitio) no puede
  -- salir a reparto. Los pedidos del bot no traen `fulfillment`: se asumen a
  -- domicilio, que es como funcionan hoy por WhatsApp.
  if p_status = 'en_camino'
     and coalesce(v_order.fulfillment, 'delivery') <> 'delivery' then
    return jsonb_build_object('result', 'not_deliverable', 'order', to_jsonb(v_order));
  end if;

  if not (
    (v_order.status = 'pendiente'
      and p_status in ('confirmado', 'preparacion', 'cancelado', 'expirado'))
    or (v_order.status = 'confirmado'
      and p_status in ('preparacion', 'en_camino', 'completado', 'cancelado', 'expirado'))
    or (v_order.status = 'preparacion'
      and p_status in ('en_camino', 'completado', 'cancelado'))
    or (v_order.status = 'en_camino'
      and p_status in ('completado', 'cancelado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  -- Entregado = vendido. Si algo fallara aquí, cae la transacción entera y el
  -- pedido tampoco queda entregado: nunca hay una cosa sin la otra.
  if p_status = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, p_order_id);
  end if;

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.set_order_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_order_status(uuid, uuid, text) to service_role;

-- ── 4. Los pedidos ya entregados que se quedaron fuera del reporte ────────
-- Al aplicar esto, cualquier pedido histórico marcado como entregado que
-- todavía no tenga venta la genera. Con la base en cero no hace nada; en una
-- base con historial, recupera lo que el reporte nunca contó.
do $$
declare
  v_pedido record;
begin
  for v_pedido in
    select id, business_id from public.orders
    where status = 'completado'
      and not exists (select 1 from public.sales s where s.order_id = orders.id)
  loop
    perform public.crear_venta_desde_pedido(v_pedido.business_id, v_pedido.id);
  end loop;
end;
$$;
