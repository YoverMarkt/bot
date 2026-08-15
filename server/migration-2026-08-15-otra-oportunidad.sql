-- ═══════════════════════════════════════════════════════════════════════════
-- PEDIR OTRO COMPROBANTE: LA SEGUNDA OPORTUNIDAD QUE FALTABA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cuando un comprobante no cuadra, el dueño solo tenía una salida real:
-- **rechazar**, que cierra el pedido y le manda al cliente «tu pedido fue
-- cancelado». El botón decía «para que mande otro» y era falso — `rechazado`
-- es un estado FINAL y la máquina de estados no permite volver a
-- `esperando_pago`.
--
-- Se pierde una venta por una foto borrosa, que es la peor forma de perderla.
--
-- ⚠️ NO se recrea `set_order_status`. Es la otra función del dinero, tiene DOS
-- definiciones en `schema.sql` —la de abajo es la que manda— y copiar la
-- equivocada es exactamente el riesgo del que avisa CLAUDE.md. Además esto no
-- es «cambiar el estado»: es una acción con nombre propio que hace tres cosas
-- que van juntas o no van.
--
-- Las tres, en una sola transacción:
--   1. el pedido vuelve a `esperando_pago`;
--   2. se BORRA el comprobante anterior — sin eso el buzón de WhatsApp
--      rechazaría la foto siguiente, porque solo adjunta cuando no hay una ya
--      puesta, y el dueño se quedaría mirando la borrosa para siempre;
--   3. se anota en `order_events`, como cualquier otro cambio de estado.
--
-- ⚠️ Y se limpia `payment_confirmed_at`: si el dueño había dado el pago por
-- bueno y luego se arrepiente, dejar la marca puesta haría que el cliente
-- siguiera viendo «Pago confirmado» mientras se le pide otro comprobante.
--
-- ⚠️ NO manda ningún WhatsApp. Cada aviso automático es dinero en todos los
-- negocios del SaaS, y aquí no hace falta: el pedido vuelve a `esperando_pago`,
-- así que al cliente le reaparece solo el aviso de pago pendiente en la tienda
-- y la pantalla que le dice qué hacer. El dueño le escribe si quiere.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor
-- (`tests/migraciones.mjs`). Lo vigila `migraciones-guardian.test.js`.

create or replace function public.request_new_payment_proof(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Solo desde «el dueño lo está mirando». Desde cualquier otro estado esto no
  -- significa nada: un pedido ya aceptado no vuelve a esperar un comprobante.
  if v_order.status <> 'pago_en_revision' then
    return jsonb_build_object(
      'result', 'invalid_transition',
      'order', to_jsonb(v_order)
    );
  end if;

  update public.orders
  set status = 'esperando_pago',
      payment_proof_url = null,
      payment_proof_public_id = null,
      payment_confirmed_at = null,
      -- El aviso se reclama por hito y este pedido vuelve atrás: sin soltar la
      -- marca, el aviso de «en preparación» no saldría cuando por fin arranque.
      customer_notified_status = null,
      updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  insert into public.order_events (business_id, order_id, from_status, to_status)
  values (p_business_id, p_order_id, 'pago_en_revision', 'esperando_pago');

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.request_new_payment_proof(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_new_payment_proof(uuid, uuid)
  to service_role;
