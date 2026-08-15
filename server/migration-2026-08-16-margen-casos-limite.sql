-- ═══════════════════════════════════════════════════════════════════════════
-- TRES CASOS LÍMITE DEL MOTOR DE MARGEN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Los tres se encontraron auditando el motor recién construido, antes de que
-- hubiera una sola regla activa en producción. Los tres son de dinero.
--
-- ── 1. EL MES TERMINA EN ECUADOR, NO EN LONDRES ───────────────────────────
--
-- `sold_at` es `timestamptz` y las fechas del cierre llegaban como `date`.
-- PostgreSQL las comparaba en la zona de la sesión, que en Supabase es UTC:
-- una venta del **31 de agosto a las 20:00 en Ecuador** son las 01:00 UTC del
-- 1 de septiembre, así que se facturaba en SEPTIEMBRE.
--
-- No es un detalle de un caso raro: son las cinco últimas horas de CADA día,
-- justo la franja de más ventas de un restaurante. Cada cierre de mes movía
-- la última noche entera al mes siguiente.
--
-- Se arregla con el mismo patrón que ya usa el reporte de consumo:
-- `p_from::timestamp at time zone 'America/Guayaquil'`.
--
-- ── 2. LA COMISIÓN NO SE COBRA SOBRE UN DESCUENTO ─────────────────────────
--
-- El margen salía de `subtotal`, que es el precio ANTES del descuento. Un
-- pedido de $100 con $20 de descuento deja $80 al comercio, y le cobrábamos
-- el 10% de $100 = $10 en vez de $8: comisión sobre dinero que nunca recibió.
--
-- Hoy `orders.discount` es siempre 0 —la tienda no aplica descuentos y el bot
-- tampoco—, así que no hay ni un centavo mal cobrado. Pero la columna existe,
-- `create_order_with_items` la acepta, y el día que se use el error aparecería
-- en silencio y en todos los negocios a la vez.
--
-- ── 3. `on_top` PROMETÍA ALGO QUE NO HACE ─────────────────────────────────
--
-- El modo decía «el margen se suma al precio del cliente», pero el disparador
-- restaba igual: con `on_top` el comercio recibía MENOS y el cliente pagaba lo
-- mismo — exactamente `absorbed` con otro nombre. Implementarlo de verdad
-- exige que el catálogo, el carrito y el resumen pinten el precio con margen,
-- o el cliente descubriría el precio real al confirmar.
--
-- Se cierra el CHECK a `absorbed` mientras tanto, igual que `scope` no admite
-- todavía 'category': **no se puede guardar una regla que el motor no honre**.
-- La columna se queda para cuando las tres pantallas estén listas.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.


-- ── 1. El mes, en hora de Ecuador ──────────────────────────────────────────
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


-- ── 2. El descuento sale de la base antes de calcular ──────────────────────
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc jsonb;
  v_base numeric(10,2);
begin
  -- La base es lo que el comercio cobra POR LOS PRODUCTOS: el subtotal menos
  -- el descuento. No incluye el envío, que no es suyo, ni la propina.
  v_base := round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0), 2);

  if v_base <= 0 then
    return new;
  end if;

  -- El panel actualiza estos pedidos muchas veces (estado, aviso,
  -- comprobante); recalcular en cada una sería trabajo tirado.
  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.discount is not distinct from old.discount
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(
    new.business_id,
    v_base,
    new.pricing_rule_id
  );

  new.merchant_subtotal    := round(v_base - (v_calc ->> 'markup')::numeric, 2);
  new.platform_markup      := (v_calc ->> 'markup')::numeric;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  return new;
end;
$$;


-- ── 3. `on_top` no se puede guardar hasta que exista de verdad ─────────────
--
-- Falla CERRADO, igual que `scope` con 'category'. Es preferible que el
-- superadmin no pueda elegirlo a que lo elija y obtenga otra cosa.
alter table public.pricing_rules
  drop constraint if exists pricing_rules_mode_check;

alter table public.pricing_rules
  add constraint pricing_rules_mode_check
  check (markup_mode = 'absorbed');

comment on column public.pricing_rules.markup_mode is
  'Solo `absorbed` por ahora. `on_top` exige que el catálogo, el carrito y el resumen pinten el precio con margen; hasta entonces el CHECK lo impide.';
