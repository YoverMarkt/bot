-- ============================================================================
-- EL PEDIDO SIN PAGAR CADUCA SOLO
--
-- De los 48 pedidos de producción, 40 acabaron cancelados — y **20 de ellos
-- murieron en `esperando_pago`**: gente que pidió y nunca mandó el
-- comprobante. Hoy esos pedidos se quedan ahí para siempre y el dueño los
-- cancela A MANO uno a uno, mientras el cliente se queda mirando una pantalla
-- de pago que ya no lleva a ninguna parte.
--
-- Una empresa seria dice «tu pedido se cancela en 2 horas si no recibimos el
-- comprobante» y CUMPLE. El estado `expirado` existía en las restricciones
-- desde el 2026-08-05 y **nadie lo escribía nunca**.
--
-- ⚠️ ESTO ROMPE UNA INVARIANTE DOCUMENTADA, y es deliberado. `order-notify.ts`
-- decía: «no puede dispararse solo: `cancelado` y `rechazado` únicamente se
-- escriben desde `PUT /api/client/orders/:id/status`… No hay tarea que expire
-- pedidos por su cuenta». La razón de esa cautela era el dinero: una tarea
-- automática puede disparar cien avisos de golpe. Los frenos que la sustituyen:
--
--   · TOPE POR TANDA (`p_limite`, 20 por defecto). Nunca cien de golpe.
--   · VENTANA SUPERIOR de 24 h: lo más viejo NO se toca. Sin ella, el día que
--     esto se encienda barrería todo el histórico de una vez, que es
--     exactamente el escenario que la nota temía.
--   · INTERRUPTOR POR NEGOCIO: `payment_window_minutes = 0` lo apaga.
--   · Y el aviso no es un gasto NUEVO: hoy el dueño cancela esos pedidos a
--     mano, y `cancelado` ya avisa. Esto sustituye ese mensaje, no lo añade.
--
-- ⚠️ Comprobado antes de escribir esto: producción tiene **CERO** pedidos en
-- `esperando_pago`, `pago_en_revision` o `pendiente`. No hay backlog que
-- barrer, así que se puede encender sin que la primera pasada toque nada.
--
-- ⚠️ NUNCA expira `pago_en_revision`: ahí el cliente YA PAGÓ y espera a que el
-- dueño mire su comprobante. Expirar eso sería quedarse con el dinero de
-- alguien y cancelarle el pedido. Solo se expira `esperando_pago` y solo si no
-- hay comprobante adjunto.
--
-- ⚠️ Solo `storefront`: el de mostrador lo teclea el dueño con la persona
-- delante, y no hay ningún pago que esperar por WhatsApp.
--
-- ⚠️ Reutiliza `set_order_status` en vez de un `update` propio: así el pedido
-- deja su rastro en `order_events`, respeta la máquina de estados —que ya
-- permitía `esperando_pago → expirado` desde el 2026-08-05— y reclama el aviso
-- con el mismo mecanismo atómico que el resto. Un `update` a mano se saltaría
-- las tres cosas. El bucle es aceptable porque `p_limite` lo acota.
-- ============================================================================

-- ── Cuánto espera cada local su comprobante ─────────────────────────────────
--
-- Lo pone el DUEÑO: dos horas sobran en una pizzería y se quedan cortas en un
-- local que reparte al día siguiente. Nace en 120 minutos.
--
-- ⚠️ Aquí el 0 SÍ vale como «no expirar nunca», al revés que
-- `max_orders_per_hour`. Ese freno protege al local de una avalancha y por eso
-- no admite infinito; este CANCELA pedidos, que es una decisión de dinero del
-- dueño — y quien cobra contra entrega o coordina por teléfono tiene motivos
-- legítimos para no querer que nada caduque.
alter table public.businesses
  add column if not exists payment_window_minutes integer not null default 120;

alter table public.businesses
  drop constraint if exists businesses_payment_window_check;
alter table public.businesses
  add constraint businesses_payment_window_check
  check (payment_window_minutes = 0
         or (payment_window_minutes >= 15 and payment_window_minutes <= 1440));

comment on column public.businesses.payment_window_minutes is
  'Minutos que el local espera el comprobante antes de expirar el pedido. 0 = no expira nunca.';

-- ── El barrido ──────────────────────────────────────────────────────────────
--
-- Devuelve lo que expiró para que el servidor mande los avisos. No los manda
-- él: la base no habla WhatsApp, y mezclarlo dejaría el envío dentro de una
-- transacción que puede tardar.
create or replace function public.expire_unpaid_orders(
  p_limite integer default 20
)
returns table (
  order_id uuid,
  business_id uuid,
  order_number integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila record;
  v_hechos integer := 0;
begin
  for v_fila in
    select o.id, o.business_id, o.order_number
    from public.orders o
    join public.businesses b on b.id = o.business_id
    where o.status = 'esperando_pago'
      and coalesce(o.source, '') = 'storefront'
      -- Mandó su comprobante: eso ya no es un pedido sin pagar, aunque el
      -- estado no haya avanzado todavía.
      and o.payment_proof_url is null
      and b.payment_window_minutes > 0
      and o.created_at < now() - make_interval(mins => b.payment_window_minutes)
      -- ⚠️ La ventana superior. Lo más viejo se queda como está: es histórico
      -- que el dueño ya gestionó o abandonó, y barrerlo de golpe es justo lo
      -- que la nota de `order-notify.ts` temía.
      and o.created_at > now() - interval '24 hours'
    order by o.created_at
    limit greatest(1, least(coalesce(p_limite, 20), 100))
  loop
    -- Si otro proceso lo movió entre el select y aquí, `set_order_status`
    -- rechaza la transición y este pedido se salta sin romper la tanda.
    begin
      perform public.set_order_status(v_fila.business_id, v_fila.id, 'expirado');
      order_id := v_fila.id;
      business_id := v_fila.business_id;
      order_number := v_fila.order_number;
      v_hechos := v_hechos + 1;
      return next;
    exception when others then
      -- Un pedido que no se pudo expirar no puede tumbar la tanda entera.
      null;
    end;
  end loop;

  return;
end;
$$;

revoke all on function public.expire_unpaid_orders(integer) from public;
grant execute on function public.expire_unpaid_orders(integer) to service_role;
