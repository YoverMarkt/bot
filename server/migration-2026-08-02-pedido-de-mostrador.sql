-- ═══════════════════════════════════════════════════════════════════════════
-- PEDIDO DE MOSTRADOR — lo que se vende en persona, por el mismo camino
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Alguien entra al local, compra y se va. Hoy eso se registraba por un camino
-- aparte («Registrar venta») que dejaba dos formas distintas de que entrara el
-- dinero. Ahora es un pedido más: nace ya entregado y genera su venta, igual
-- que el que llega por la tienda o por WhatsApp.
--
-- Un solo camino, un solo destino: `sales`.
--
-- Dos detalles que parecen menores y no lo son:
--
--  · `orders.contact_phone` es NOT NULL, pero en el mostrador muchas veces no
--    hay teléfono. Se guarda el literal 'mostrador' y la VENTA lo convierte a
--    nulo: si no, el directorio de clientes acabaría con un cliente fantasma
--    con cientos de compras que arruinaría «frecuentes» y «clientes perdidos».
--
--  · La venta se crea DENTRO de create_order_with_items cuando el pedido nace
--    entregado, no en una segunda llamada desde Node. Si fueran dos pasos, un
--    fallo entre ellos dejaría un pedido cobrado sin venta.
--
-- Idempotente. Aplicar con `npm run migrate`.

-- ── 1. La venta no hereda el teléfono postizo del mostrador ───────────────
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

revoke all on function public.crear_venta_desde_pedido(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_pedido(uuid, uuid) to service_role;

-- ── 2. Un pedido que nace entregado registra su venta ─────────────────────
-- Se añade `p_source` para poder distinguir el mostrador del bot sin que Node
-- tenga que escribir en la tabla por su cuenta.
drop function if exists public.create_order_with_items(
  uuid, text, text, text, numeric, text, jsonb
);

create or replace function public.create_order_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_status text,
  p_discount numeric,
  p_currency text,
  p_items jsonb,
  p_source text default 'whatsapp'
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_item jsonb;
  v_normalized_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_product_name text;
  v_product_stock text;
  v_quantity integer;
  v_requested_price numeric(10,2);
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := round(coalesce(p_discount, 0), 2);
  v_total numeric(10,2);
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if coalesce(p_status, 'pendiente') not in (
    'pendiente', 'confirmado', 'completado', 'cancelado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;
  if coalesce(p_source, 'whatsapp') not in ('whatsapp', 'storefront', 'marketplace', 'manual') then
    raise exception using errcode = '22023', message = 'Origen de pedido inválido';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido necesita al menos un ítem';
  end if;
  if v_discount < 0 then
    raise exception using errcode = '22023', message = 'El descuento no puede ser negativo';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Cada ítem debe ser un objeto';
    end if;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    v_requested_price := round((v_item ->> 'unit_price')::numeric, 2);
    if v_product_id is null then
      raise exception using errcode = '22023', message = 'El producto es obligatorio';
    end if;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;
    select
      p.name,
      round(case when p.price_sale > 0 then p.price_sale else p.price end, 2),
      p.stock
    into v_product_name, v_unit_price, v_product_stock
    from products p
    where p.id = v_product_id
      and p.business_id = p_business_id
      and p.active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product_stock = 'agotado' then
      raise exception using errcode = '22023', message = 'El producto está agotado';
    end if;
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = 'El producto no tiene un precio válido';
    end if;
    if v_requested_price is distinct from v_unit_price then
      raise exception using errcode = '40001', message = 'El precio cambió; vuelve a calcular el pedido';
    end if;
    v_line_total := round(v_quantity * v_unit_price, 2);
    v_subtotal := v_subtotal + v_line_total;
    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id, 'product_name', v_product_name,
      'quantity', v_quantity, 'unit_price', v_unit_price, 'line_total', v_line_total
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  if v_discount > v_subtotal then
    raise exception using errcode = '22023', message = 'El descuento supera el subtotal';
  end if;
  v_total := round(v_subtotal - v_discount, 2);

  insert into orders (
    business_id, contact_phone, contact_name, status,
    subtotal, discount, total, currency, source
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    coalesce(p_status, 'pendiente'), v_subtotal, v_discount, v_total,
    coalesce(nullif(btrim(p_currency), ''), 'USD'), coalesce(p_source, 'whatsapp')
  ) returning * into v_order;

  insert into order_items (
    order_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_order.id, p_business_id, nullif(item ->> 'product_id', '')::uuid,
    item ->> 'product_name', (item ->> 'quantity')::integer,
    (item ->> 'unit_price')::numeric, (item ->> 'line_total')::numeric
  from jsonb_array_elements(v_normalized_items) as item;

  -- Nace entregado (mostrador): la venta se crea aquí, no en una segunda
  -- llamada desde Node que podría no ocurrir si algo falla entre medias.
  if coalesce(p_status, 'pendiente') = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, v_order.id);
  end if;

  return to_jsonb(v_order);
end;
$$;


revoke all on function public.create_order_with_items(
  uuid, text, text, text, numeric, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.create_order_with_items(
  uuid, text, text, text, numeric, text, jsonb, text
) to service_role;
