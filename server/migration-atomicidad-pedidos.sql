-- Crea un pedido del bot y todos sus ítems en una sola transacción PostgreSQL.
-- Recalcula los totales y valida que los productos pertenezcan al negocio.
-- Es idempotente: puede ejecutarse nuevamente para actualizar la función.

create or replace function public.create_order_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_status text,
  p_discount numeric,
  p_currency text,
  p_items jsonb
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
  v_quantity integer;
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
    v_product_name := btrim(coalesce(v_item ->> 'product_name', ''));
    v_quantity := (v_item ->> 'quantity')::integer;
    v_unit_price := round((v_item ->> 'unit_price')::numeric, 2);

    if v_product_name = '' then
      raise exception using errcode = '22023', message = 'El nombre del producto es obligatorio';
    end if;
    if v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'La cantidad debe ser mayor que cero';
    end if;
    if v_unit_price <= 0 then
      raise exception using errcode = '22023', message = 'El precio debe ser mayor que cero';
    end if;
    if v_product_id is not null and not exists (
      select 1 from products p
      where p.id = v_product_id
        and p.business_id = p_business_id
        and p.active = true
    ) then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;

    v_line_total := round(v_quantity * v_unit_price, 2);
    v_subtotal := v_subtotal + v_line_total;
    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'product_name', v_product_name,
      'quantity', v_quantity,
      'unit_price', v_unit_price,
      'line_total', v_line_total
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  if v_discount > v_subtotal then
    raise exception using errcode = '22023', message = 'El descuento supera el subtotal';
  end if;
  v_total := round(v_subtotal - v_discount, 2);

  insert into orders (
    business_id,
    contact_phone,
    contact_name,
    status,
    subtotal,
    discount,
    total,
    currency
  ) values (
    p_business_id,
    btrim(p_contact_phone),
    nullif(btrim(p_contact_name), ''),
    coalesce(p_status, 'pendiente'),
    v_subtotal,
    v_discount,
    v_total,
    coalesce(nullif(btrim(p_currency), ''), 'USD')
  ) returning * into v_order;

  insert into order_items (
    order_id,
    business_id,
    product_id,
    product_name,
    quantity,
    unit_price,
    line_total
  )
  select
    v_order.id,
    p_business_id,
    nullif(item ->> 'product_id', '')::uuid,
    item ->> 'product_name',
    (item ->> 'quantity')::integer,
    (item ->> 'unit_price')::numeric,
    (item ->> 'line_total')::numeric
  from jsonb_array_elements(v_normalized_items) as item;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) from public;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) from anon;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) from authenticated;
grant execute on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb) to service_role;
