-- ═══════════════════════════════════════════════════════════════════════════
-- ESTADOS DE PEDIDO PARA REPARTO — «preparacion» y «en_camino»
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Por qué AHORA: hoy `orders` no tiene ni un pedido real. Añadir estados con la
-- tabla vacía es cambiar un CHECK; con una pizzería operando es migrar los
-- datos de un cliente vivo. Se hace antes de construir la sección Pedidos
-- porque esa pantalla se construye ALREDEDOR de estos estados.
--
-- El flujo, siempre hacia adelante:
--
--   pendiente ──> confirmado ──> preparacion ──> en_camino ──> completado
--       │             │              │              │
--       └─────────────┴──────────────┴──────────────┴──────> cancelado
--
--   · Se puede saltar hacia adelante (aceptar y poner a preparar es un solo
--     gesto; un pedido que se retira en el local no pasa por «en_camino»).
--   · NO se retrocede. Si algo sale mal, se cancela: es lo único que se puede
--     auditar sin ambigüedad.
--   · `en_camino` queda BLOQUEADO en la base para pedidos `pickup`/`onsite`.
--     Un pedido para retirar no sale a la calle ni por un error de la pantalla.
--
-- NO toca `create_order_with_items` a propósito: los estados nuevos nunca son
-- iniciales. A `preparacion` y `en_camino` solo se llega por `set_order_status`,
-- que es quien valida las transiciones.
--
-- Idempotente: se puede ejecutar varias veces sin efecto adicional.
-- Aplicar con `npm run migrate` (o pegándola en el SQL Editor de Supabase).

-- ── 1. El CHECK de estados ────────────────────────────────────────────────
-- El original se creó en línea dentro del `create table`, así que PostgreSQL lo
-- nombró `orders_status_check`. Se reemplaza por la lista ampliada; ninguna
-- fila existente puede violarlo porque solo se AÑADEN valores permitidos.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (
  status in (
    'pendiente', 'confirmado', 'preparacion', 'en_camino',
    'completado', 'cancelado', 'expirado'
  )
);

-- ── 2. Índice de pedidos ACTIVOS ──────────────────────────────────────────
-- Lo justifica una consulta real: la alarma del panel pregunta por los
-- pendientes de cada negocio cada 12 segundos, y la bandeja de Pedidos listará
-- los que siguen en curso. Parcial para que no encarezca los pedidos cerrados,
-- que son la inmensa mayoría con el tiempo.
create index if not exists idx_orders_activos
  on public.orders (business_id, created_at desc)
  where status in ('pendiente', 'confirmado', 'preparacion', 'en_camino');

-- ── 3. La máquina de estados ──────────────────────────────────────────────
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

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.set_order_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_order_status(uuid, uuid, text) to service_role;
