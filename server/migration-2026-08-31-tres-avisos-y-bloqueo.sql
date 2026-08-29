-- ════════════════════════════════════════════════════════════════════════
-- QUIEN PIDE TRES VECES Y NUNCA PAGA, DEJA DE PODER PEDIR EN ESE LOCAL
-- ════════════════════════════════════════════════════════════════════════
--
-- El 2026-08-28 un mismo teléfono dejó SEIS pedidos sin pagar en Monster
-- Pizza (#62 a #68). Ninguno era fraude sofisticado: pedía, no transfería, el
-- pedido caducaba, el candado se soltaba y volvía a pedir. El local preparaba
-- expectativas y liberaba stock una y otra vez.
--
-- El freno que faltaba no es impedir pedir —eso ya lo hace el candado de «un
-- pedido a la vez»—, es que ABANDONAR tenga consecuencia.
--
-- ⚠️ Se cuenta por CLIENTE y NEGOCIO, no global: quien abandona en una
-- pizzería puede ser un cliente impecable en la heladería de al lado, y
-- castigarlo en toda la plataforma por lo que hizo en un local sería un
-- bloqueo que él no puede ni entender ni resolver. `business_customers` ya es
-- la fila por (negocio, cliente), así que el contador vive ahí.
--
-- ⚠️ Y NO se toca `expire_unpaid_orders`. Esa función barre y devuelve lo que
-- expiró; quien registra la falta es el servidor, en el mismo bucle donde ya
-- manda el aviso. Cambiarle la firma de retorno para colar un dato obligaría a
-- recrearla entera, que es justo lo que este proyecto evita con las funciones
-- que ya funcionan.

-- ── 1. El contador de pedidos abandonados ──────────────────────────────────
alter table public.business_customers
  add column if not exists unpaid_expiries integer not null default 0;

comment on column public.business_customers.unpaid_expiries is
  'Pedidos que este cliente dejó caducar sin comprobante EN ESTE NEGOCIO. Al tercero se bloquea solo. No se reinicia al bloquear: el dueño lo desbloquea a mano y el historial se conserva.';

-- ── 2. Registrar la falta, y bloquear al tercero ───────────────────────────
--
-- Devuelve `{strikes, blocked, limit}` para que el aviso pueda decir la
-- verdad: cuántas van, y si esta fue la última.
--
-- ⚠️ El incremento y el bloqueo van en UNA sentencia. Comprobar primero y
-- actualizar después deja una carrera en la que dos barridos simultáneos leen
-- el mismo 2 y ninguno bloquea. Es el mismo patrón que `last_order_number`.
--
-- ⚠️ `blocked_at` solo se pone si estaba en nulo: si el dueño ya lo había
-- bloqueado a mano, la fecha es la SUYA y no se pisa.
create or replace function public.register_unpaid_expiry(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limite  constant integer := 3;
  v_cliente uuid;
  v_fila    record;
begin
  -- El cliente sale del PEDIDO, no de un parámetro: así no hay forma de sumarle
  -- una falta a un tercero, y el negocio se comprueba en la misma consulta.
  select customer_id into v_cliente
  from public.orders
  where id = p_order_id
    and business_id = p_business_id;

  -- Un pedido del bot o de mostrador puede no tener cliente asociado. Sin
  -- cliente no hay a quién contarle nada, y eso no es un error.
  if v_cliente is null then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  update public.business_customers
  set unpaid_expiries = unpaid_expiries + 1,
      blocked_at = case
        when blocked_at is not null then blocked_at
        when unpaid_expiries + 1 >= v_limite then now()
        else null
      end,
      updated_at = now()
  where business_id = p_business_id
    and customer_id = v_cliente
  returning unpaid_expiries, blocked_at into v_fila;

  if not found then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  return jsonb_build_object(
    'strikes', v_fila.unpaid_expiries,
    'blocked', v_fila.blocked_at is not null,
    'limit', v_limite
  );
end;
$$;

revoke all on function public.register_unpaid_expiry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_unpaid_expiry(uuid, uuid) to service_role;

-- ── 3. La ventana de pago baja de 120 minutos a 15 ─────────────────────────
--
-- Dos horas es tiempo de sobra para transferir, y mientras tanto el pedido
-- ocupa el candado del cliente y la cabeza del dueño. Medido contra lo que
-- tarda de verdad una transferencia —abrir el banco, buscar la cuenta, el
-- código de un solo uso, volver y mandar la foto— son unos 8 minutos: 15 deja
-- margen sin premiar al que nunca pensó pagar.
--
-- ⚠️ Solo se mueve a quien tenía el valor por defecto. Un dueño que lo haya
-- ajustado a mano decidió su número, y esta migración no es quién para pisarlo.
alter table public.businesses
  alter column payment_window_minutes set default 15;

update public.businesses
set payment_window_minutes = 15
where payment_window_minutes = 120;
