-- ============================================================================
-- EL CLIENTE SERIO NO SE SILENCIA, Y EL BLOQUEADO SABE POR QUÉ
--
-- Dos cosas que el dueño pidió el 2026-08-25 mirando su propio WhatsApp.
--
-- ── 1. Pedir suelta el techo ────────────────────────────────────────────────
--
-- `claim_marketplace_reply` (2026-08-24) cuenta 25 RESPUESTAS por hora y a la
-- 26 calla 12 h. El tope es alto a propósito, pero cuenta respuestas, no
-- intenciones: armar un pedido DENTRO del chat son 15-25 mensajes —categoría,
-- local, productos, opciones, dirección, pago, confirmación—, así que un
-- cliente que pide dos veces en la misma hora se come el techo entero y se
-- queda mudo 12 horas. No es una hipótesis: es exactamente lo que va a pasar
-- el día que se dé de alta un local con `pide_en_chat = true`, y le pasará al
-- cliente que MÁS pide, que es el que menos conviene silenciar.
--
-- ⚠️ Se suelta al CREAR EL PEDIDO, no antes: es el único momento en que el
-- cliente ha demostrado con hechos que no es quien molesta. Quien recorre el
-- menú sin pedir nunca sigue contando, que es justo a quien apunta el techo.
-- Es el mismo criterio con el que ya se suelta `shopping_locked`.
--
-- ⚠️ NO levanta un silencio YA activo (`muted_until` no se toca). Si bastara
-- con pedir para recuperar la voz, el silenciado haría un pedido falso y
-- volvería a empezar. Lo que se evita es ACUMULAR hacia el silencio mientras
-- se compra, no perdonar el que ya cayó. Quien esté silenciado sigue estándolo
-- hasta que venza, y el dueño siempre puede desbloquearlo.
--
-- ⚠️ Va en un DISPARADOR y no dentro de `create_storefront_order`: la misma
-- regla que ya siguieron `orders_reject_blocked`, `orders_stamp_pricing` y los
-- frenos del #269/#270 —la función del dinero no se recrea por un añadido— y
-- así queda cubierto cualquier camino, incluidos los que no existen todavía.
--
-- ⚠️ AFTER insert, y falla ABIERTO: el pedido ya está hecho y en la cocina.
-- Que no se pueda soltar un contador no puede tumbarlo.
--
-- ⚠️ Solo `storefront`: el pedido de MOSTRADOR lo teclea el dueño con la
-- persona delante, y no puede ser una vía para soltarle el contador a nadie.
--
-- ── 2. Al bloqueado se le dice por qué, UNA vez ─────────────────────────────
--
-- Hasta hoy la regla era «NUNCA se le avisa»: quien molesta busca una reacción
-- y cada aviso cuesta el mensaje que el bloqueo existe para ahorrar. El
-- problema es que, callando siempre, el cliente que fue bloqueado por hacer
-- pedidos y no recogerlos no se entera nunca de qué hizo mal — y el que fue
-- bloqueado por error, tampoco.
--
-- ⚠️ El punto medio es el RECLAMO, no el silencio ni la repetición: se le
-- explica en su PRIMER intento tras el bloqueo y a partir del segundo se
-- vuelve al mensaje neutro de siempre. Así recibe la información una sola vez
-- y el bloqueado nunca cuesta más mensajes que un cliente normal, que es lo
-- que pasaría avisando cada vez: quien molesta insiste.
--
-- ⚠️ El reclamo va DENTRO del `update`, no en un `select` previo: entre mirar
-- y escribir caben dos mensajes del mismo cliente, y entonces el aviso saldría
-- —y se pagaría— dos veces. Mismo patrón que `customer_notified_status`.
--
-- ⚠️ Desbloquear LIMPIA la marca: si el dueño lo vuelve a bloquear más
-- adelante, esa es una decisión nueva y merece su propia explicación.
-- ============================================================================

-- ── 1. Pedir suelta el techo ────────────────────────────────────────────────

create or replace function public.orders_reset_marketplace_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  -- `muted_until` NO se toca: pedir no levanta un silencio ya caído.
  update public.marketplace_conversations
     set reply_count = 0,
         reply_window_start = null,
         updated_at = now()
   where customer_id = new.customer_id
     and coalesce(reply_count, 0) > 0;

  return new;
exception when others then
  -- Falla ABIERTO. El pedido ya existe; un contador sin soltar es una
  -- molestia, tumbar la comanda es perder la venta.
  return new;
end;
$$;

drop trigger if exists orders_reset_marketplace_reply on public.orders;
create trigger orders_reset_marketplace_reply
  after insert on public.orders
  for each row execute function public.orders_reset_marketplace_reply();

-- ── 2. El aviso de bloqueo, una sola vez ────────────────────────────────────

alter table public.business_customers
  add column if not exists blocked_notified_at timestamptz;

comment on column public.business_customers.blocked_notified_at is
  'Cuándo se le explicó el bloqueo. Se reclama una vez y se limpia al desbloquear.';

create or replace function public.claim_blocked_notice(
  p_business_id uuid,
  p_customer_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reclamado boolean;
begin
  if p_business_id is null or p_customer_id is null then
    return false;
  end if;

  -- Las cuatro condiciones van en el `where`: es UNA operación atómica, así
  -- que dos mensajes simultáneos del mismo cliente no pueden reclamar los dos.
  update public.business_customers
     set blocked_notified_at = now(),
         updated_at = now()
   where business_id = p_business_id
     and customer_id = p_customer_id
     and blocked_at is not null
     and blocked_notified_at is null
  returning true into v_reclamado;

  return coalesce(v_reclamado, false);
end;
$$;

revoke all on function public.claim_blocked_notice(uuid, uuid) from public;
grant execute on function public.claim_blocked_notice(uuid, uuid) to service_role;
