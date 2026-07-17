-- Crea una venta manual y todos sus detalles en una sola transacción PostgreSQL.
-- Si cualquier validación o INSERT falla, PostgreSQL revierte la operación completa.
-- Es idempotente: puede ejecutarse nuevamente para actualizar la función.

create or replace function public.create_sale_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_created_by uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sale sales%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_product_name text;
  v_quantity integer;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_total numeric(10,2) := 0;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'La venta necesita al menos un ítem';
  end if;

  if p_created_by is not null and not exists (
    select 1
    from client_users cu
    where cu.id = p_created_by
      and cu.business_id = p_business_id
  ) then
    raise exception using errcode = '42501', message = 'El usuario no pertenece al negocio';
  end if;

  insert into sales (
    business_id,
    contact_phone,
    contact_name,
    total,
    status,
    source,
    created_by
  ) values (
    p_business_id,
    nullif(btrim(p_contact_phone), ''),
    nullif(btrim(p_contact_name), ''),
    0,
    'completada',
    'manual',
    p_created_by
  )
  returning * into v_sale;

  for v_item in
    select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Cada ítem debe ser un objeto';
    end if;

    v_product_name := btrim(coalesce(v_item ->> 'product_name', ''));
    v_quantity := (v_item ->> 'quantity')::integer;
    v_unit_price := round((v_item ->> 'unit_price')::numeric, 2);
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;

    if v_product_name = '' then
      raise exception using errcode = '22023', message = 'El nombre del producto es obligatorio';
    end if;
    if v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'La cantidad debe ser mayor que cero';
    end if;
    if v_unit_price < 0 then
      raise exception using errcode = '22023', message = 'El precio no puede ser negativo';
    end if;
    if v_product_id is not null and not exists (
      select 1
      from products p
      where p.id = v_product_id
        and p.business_id = p_business_id
    ) then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;

    v_line_total := round(v_quantity * v_unit_price, 2);
    v_total := v_total + v_line_total;

    insert into sale_items (
      sale_id,
      business_id,
      product_id,
      product_name,
      quantity,
      unit_price,
      line_total
    ) values (
      v_sale.id,
      p_business_id,
      v_product_id,
      v_product_name,
      v_quantity,
      v_unit_price,
      v_line_total
    );
  end loop;

  update sales
  set total = v_total
  where id = v_sale.id
    and business_id = p_business_id
  returning * into v_sale;

  return to_jsonb(v_sale);
end;
$$;

-- La aplicación invoca esta RPC únicamente desde el backend con service_role.
revoke all on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) from public;
revoke all on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) from anon;
revoke all on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) from authenticated;
grant execute on function public.create_sale_with_items(uuid, text, text, uuid, jsonb) to service_role;
