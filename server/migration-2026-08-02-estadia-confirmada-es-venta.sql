-- ═══════════════════════════════════════════════════════════════════════════
-- UNA ESTADÍA CONFIRMADA ES UNA VENTA — el estándar llega a hospedaje
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Último camino que quedaba fuera. Hasta hoy el ingreso por hospedaje se
-- calculaba APARTE, en `reports.computeLodgingIncome`, sumando estadías
-- confirmadas. Funcionaba, pero dejaba al dueño de un hostal con dos números
-- que no se juntaban: sus ventas por un lado y sus estadías por otro.
--
-- Con esto los cuatro caminos terminan en el mismo sitio:
--
--   Pedido entregado    → venta
--   Pedido de mostrador → venta
--   Cita atendida       → venta
--   Estadía CONFIRMADA  → venta      ← esto
--
-- ⚠️ Por qué al CONFIRMAR y no al terminar la estadía: confirmar es el momento
-- en que el hostal se compromete y retiene el cupo, y es exactamente lo que ya
-- contaba el reporte de ingresos. Cambiarlo a la salida movería los números
-- históricos del negocio sin que nadie lo pidiera.
--
-- Idempotente. Aplicar con `npm run migrate`.

-- ── 1. La venta sabe de qué estadía salió ─────────────────────────────────
alter table public.sales
  add column if not exists lodging_request_id uuid
    references public.lodging_requests(id) on delete set null;

-- Una estadía, una venta como máximo. Igual que en pedidos y citas: es lo que
-- impide duplicar el dinero si se confirma dos veces.
create unique index if not exists uq_sales_lodging
  on public.sales (lodging_request_id) where lodging_request_id is not null;

-- ── 2. La conversión ──────────────────────────────────────────────────────
create or replace function public.crear_venta_desde_estadia(
  p_business_id uuid,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.lodging_requests%rowtype;
  v_sale_id uuid;
  v_nombre text;
begin
  select * into v_request
  from public.lodging_requests
  where id = p_request_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where lodging_request_id = p_request_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo confirmado. Una solicitud pendiente o rechazada no es
  -- dinero, igual que un pedido sin entregar.
  if v_request.status is distinct from 'confirmed' then
    return null;
  end if;
  if coalesce(v_request.total, 0) <= 0 then
    return null;
  end if;

  -- El nombre del ítem describe la estadía como la leería el dueño tres meses
  -- después: «Estadía 3 noches (2026-08-10 → 2026-08-13)».
  v_nombre := format(
    'Estadía %s noche%s (%s → %s)',
    v_request.nights,
    case when v_request.nights = 1 then '' else 's' end,
    v_request.check_in, v_request.check_out
  );

  insert into public.sales (
    business_id, lodging_request_id, contact_phone, contact_name,
    total, status, source, sold_at
  ) values (
    p_business_id, p_request_id, v_request.contact_phone, v_request.contact_name,
    v_request.total, 'completada', 'hospedaje',
    coalesce(v_request.confirmed_at, now())
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  ) values (
    -- Sin `product_id`: una habitación no vive en el catálogo de productos,
    -- vive en el inventario de hospedaje. Poner uno inventado ensuciaría
    -- «lo más vendido» con algo que no es un producto.
    v_sale_id, p_business_id, null, v_nombre, 1, v_request.total, v_request.total
  );

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_estadia(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_estadia(uuid, uuid) to service_role;

-- ── 3. Confirmar la estadía registra su venta ─────────────────────────────
-- Se envuelve la función existente en vez de reescribirla: así no se toca ni
-- una línea del anti-sobreventa, que es lo delicado de este módulo.
create or replace function public.set_lodging_request_status_v2(
  p_business_id uuid,
  p_request_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resultado jsonb;
begin
  v_resultado := public.set_lodging_request_status(p_business_id, p_request_id, p_status);

  -- Misma transacción: si la venta fallara, la estadía tampoco queda
  -- confirmada. Nunca hay una cosa sin la otra.
  if p_status = 'confirmed' and v_resultado ->> 'result' = 'updated' then
    perform public.crear_venta_desde_estadia(p_business_id, p_request_id);
  end if;

  return v_resultado;
end;
$$;

revoke all on function public.set_lodging_request_status_v2(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_lodging_request_status_v2(uuid, uuid, text) to service_role;

-- ── 4. Las estadías ya confirmadas entran al reporte ──────────────────────
-- Sin esto, un hostal que ya venía operando vería sus ingresos empezar de cero
-- el día que se aplique la migración.
do $$
declare
  v_estadia record;
begin
  for v_estadia in
    select id, business_id from public.lodging_requests
    where status = 'confirmed'
      and not exists (
        select 1 from public.sales s where s.lodging_request_id = lodging_requests.id
      )
  loop
    perform public.crear_venta_desde_estadia(v_estadia.business_id, v_estadia.id);
  end loop;
end;
$$;
