-- ============================================================================
-- FINANZAS SEPARA LA CARRERA: NO ES DEL LOCAL NI DE LA PLATAFORMA
--
-- Dicho por el dueño el 2026-09-21, mirando Finanzas del superadmin: «en
-- finanzas suma el valor de la carrera… ¿aquí no solo debería colocarse el
-- valor de venta y mi comisión? Los $15.18 son con los 2 dólares de carrera,
-- que no entran al local sino que son del repartidor».
--
-- ── EL PROBLEMA ─────────────────────────────────────────────────────────────
--
-- `platform_markup_summary` devolvía `comercio = bruto − margen`, y `bruto` es
-- `sum(sales.total)`: lo que pagó el CLIENTE, con la carrera dentro. Así que
-- «Se queda» y «Te quedas» le atribuían al local un dinero que es de quien
-- reparte.
--
-- Sobre el pedido de staging ($11.98 de comida + $2.00 de carrera + $1.20 de
-- servicio = $15.18 que paga el cliente):
--
--     antes →  Vendido $15.18   ·   Se queda $13.98   ·   Nos debe $1.20
--     ahora →  Vendido $11.98   ·   Reparto $2.00     ·   Nos debe $1.20
--
-- Es el mismo arreglo que ya se hizo en la tarjeta del pedido (#397), aplicado
-- donde se suma el mes.
--
-- ── LAS TRES BOLSAS, QUE NO SE MEZCLAN ──────────────────────────────────────
--
--   · `productos` → del LOCAL, por su comida. Es su venta de verdad.
--   · `reparto`   → de QUIEN ENTREGA. Hoy reparte el propio local, así que hoy
--                   también acaba en su bolsillo, pero por llevar la comida y
--                   no por venderla. Van separadas desde ya para que el día que
--                   exista el módulo de repartidores no haya que volver a
--                   explicarle al dueño por qué le baja un número.
--   · `margen`    → de la PLATAFORMA. **No cambia ni un centavo.**
--
-- ⚠️ `margen` SE QUEDA EXACTAMENTE IGUAL, y es deliberado: de ahí salen la
-- factura del mes (`settle_month_commission`) y el arrastre
-- (`carry_commission_adjustments`). Este cambio no toca lo que nadie debe,
-- solo cómo se lee lo que el local vendió. Las dos funciones leen `margen`,
-- `pedidos` y `business_id` por NOMBRE, así que añadir columnas no las afecta.
--
-- ⚠️ El servicio de la plataforma YA se calculaba solo sobre el producto
-- —`orders_stamp_pricing` usa `subtotal − discount`, sin envío— y eso tampoco
-- se toca. Lo único que estaba mal era el reparto que se ENSEÑABA.
--
-- ── SE VA `comercio` ────────────────────────────────────────────────────────
--
-- En vez de dejarla al lado de `productos`, se RETIRA. Era justo la columna
-- equivocada, y conservarla «por compatibilidad» garantiza que alguien vuelva
-- a pintarla dentro de un año. Sus dos únicos consumidores —la tarjeta de
-- Finanzas del comercio y la tabla del superadmin— se cambian en esta misma
-- entrega.
--
-- ⚠️ Cambia la forma de la tabla que devuelve, así que hace falta `drop` antes
-- de `create`: `create or replace` no admite columnas nuevas de salida.
-- ============================================================================

drop function if exists public.platform_markup_summary(date, date, uuid);

create function public.platform_markup_summary(
  p_from        date,
  p_to          date,
  p_business_id uuid default null
)
returns table (
  business_id   uuid,
  business_name text,
  pedidos       bigint,
  -- Lo que pagó el cliente, entero. Se conserva porque es con lo que se
  -- concilia: productos + reparto + margen tiene que dar esto.
  bruto         numeric,
  -- De la PLATAFORMA. No cambia: la factura del mes sale de aquí.
  margen        numeric,
  -- De QUIEN ENTREGA. Ni del local ni de la plataforma.
  reparto       numeric,
  -- Del LOCAL, por su comida. Esta es su venta de verdad.
  productos     numeric
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
    -- `left join` + coalesce: una venta sin pedido —una cita, una estadía, el
    -- mostrador— no tiene carrera, y ahí `reparto` es 0 y `productos` es todo.
    round(coalesce(sum(o.shipping), 0), 2)         as reparto,
    round(coalesce(sum(s.total), 0)
        - coalesce(sum(o.platform_markup), 0)
        - coalesce(sum(o.shipping), 0), 2)         as productos
  from public.sales s
  join public.businesses b on b.id = s.business_id
  left join public.orders o on o.id = s.order_id
  where s.status = 'completada'
    -- El día empieza y acaba en Ecuador. Sin esto, las ventas de 19:00 a
    -- medianoche —la franja de más movimiento— caen en el día siguiente, y
    -- las del último día del mes, en el mes siguiente.
    and s.sold_at >= (p_from::timestamp at time zone 'America/Guayaquil')
    and s.sold_at <  (p_to::timestamp   at time zone 'America/Guayaquil')
    and (p_business_id is null or s.business_id = p_business_id)
  group by s.business_id
  order by round(coalesce(sum(o.platform_markup), 0), 2) desc;
$$;

revoke all on function public.platform_markup_summary(date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.platform_markup_summary(date, date, uuid)
  to service_role;
