-- ═══════════════════════════════════════════════════════════════════════════
-- CUÁNTO LLEVA ACUMULADO CADA COMERCIO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El motor ya sella el margen en cada pedido, pero nadie podía SUMARLO. Sin
-- esto el margen se calcula y no llega a ninguna factura: la plataforma
-- seguiría cobrando solo la cuota mensual.
--
-- ── DE DÓNDE SALE EL NÚMERO, Y POR QUÉ DE AHÍ ─────────────────────────────
--
-- Se suma sobre `sales`, NO sobre `orders`. La diferencia importa: un pedido
-- puede estar creado, aceptado o en preparación y todavía no ser dinero. La
-- venta nace cuando el pedido se ENTREGA, que es el estándar que ya siguen
-- todos los reportes del dueño desde el 2026-08-02.
--
-- Consecuencias deliberadas de sumar por ahí:
--
--   · Un pedido cancelado o rechazado NUNCA llega a `sales`, así que no
--     genera comisión. No hay que excluirlo: no está.
--   · Una venta ANULADA deja de contar (`status = 'completada'`). Es la
--     devolución del §35 sin construir nada nuevo.
--   · Las ventas de citas y estadías no llevan margen todavía —`platform_markup`
--     vive en `orders`— y entran con 0. El `left join` las cuenta en el bruto
--     pero no inventa comisión donde no la hubo.
--
-- ── LA FECHA QUE MANDA ES `sold_at` ───────────────────────────────────────
--
-- No `orders.created_at`. Un pedido de fin de mes que se entrega el día 1
-- pertenece al mes en que se cobró, no a aquel en que se pidió. Si se contara
-- por la fecha del pedido, cerrar un mes cambiaría números ya facturados cada
-- vez que se entregara algo pendiente.
--
-- ⚠️ `p_business_id` nulo devuelve TODOS los negocios y existe solo para el
-- panel del superadmin. La ruta del comercio SIEMPRE pasa su `businessId` del
-- JWT, nunca un parámetro que el cliente pueda tocar (regla inviolable #1).
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.

create or replace function public.platform_markup_summary(
  p_from        date,
  p_to          date,
  p_business_id uuid default null
)
returns table (
  business_id   uuid,
  business_name text,
  pedidos       bigint,
  bruto         numeric,
  margen        numeric,
  comercio      numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.business_id,
    max(b.name)                                    as business_name,
    count(*)                                       as pedidos,
    round(coalesce(sum(s.total), 0), 2)            as bruto,
    round(coalesce(sum(o.platform_markup), 0), 2)  as margen,
    round(coalesce(sum(s.total), 0)
        - coalesce(sum(o.platform_markup), 0), 2)  as comercio
  from public.sales s
  join public.businesses b on b.id = s.business_id
  -- `left`: una venta de cita o estadía no tiene pedido detrás y debe contar
  -- en el bruto igualmente.
  left join public.orders o on o.id = s.order_id
  where s.status = 'completada'
    and s.sold_at >= p_from
    and s.sold_at <  p_to
    and (p_business_id is null or s.business_id = p_business_id)
  group by s.business_id
  order by round(coalesce(sum(o.platform_markup), 0), 2) desc;
$$;

revoke all on function public.platform_markup_summary(date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.platform_markup_summary(date, date, uuid)
  to service_role;
