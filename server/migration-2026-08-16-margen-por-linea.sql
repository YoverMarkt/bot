-- ═══════════════════════════════════════════════════════════════════════════
-- EL MARGEN SE CALCULA POR LÍNEA, COMO SE MUESTRA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Cimiento de `on_top`: el dueño pone lo que quiere ganar por su plato, lo
-- recibe entero, y el margen va encima en el precio del cliente.
--
-- ── EL CÉNTIMO QUE OBLIGA A ESTO ──────────────────────────────────────────
--
-- Con `on_top` el cliente ve el precio de CADA producto ya con margen. Si el
-- servidor lo aplicara al subtotal, los dos caminos divergen:
--
--   Tres empanadas a $3.33, margen 8 %
--     lo que ve el cliente : round(3.33 × 1.08, 2) = $3.60 × 3 = $10.80
--     sobre el subtotal    : $9.99 + 8 % = $0.80          → $10.79
--
-- Un céntimo, pero es «el cliente ve un número y paga otro»: justo lo que la
-- regla inviolable #8 existe para impedir. Se calcula por línea, redondeando
-- donde se redondea al mostrarlo.
--
-- ── LO QUE LA MATEMÁTICA OBLIGA A PROHIBIR ────────────────────────────────
--
-- ⚠️ **`on_top` es incompatible con el techo, el piso y las estrategias que no
-- son porcentaje.** No es una decisión de producto: no se puede a la vez
-- mostrar un precio por producto y recortar el total.
--
--   Canasta de $150, 4 % con techo de $3:
--     por producto suman ......... $156.00
--     con el techo el total sería . $153.00
--
-- Los $3 de diferencia no tienen dónde aparecer: habría que repartirlos entre
-- los productos y ninguno mostraría su precio real. Por eso el CHECK exige que
-- `on_top` vaya con `percentage` y sin límites.
--
-- Y encaja con la realidad comercial: el techo existe para el SUPERMERCADO,
-- donde el cliente compara producto a producto con la tienda física y el
-- margen visible se nota. `on_top` es para el RESTAURANTE, donde nadie sabe de
-- memoria el precio en el local. Cada modo va donde tiene sentido.
--
-- ── LOS DOS CAMINOS DE CREACIÓN ───────────────────────────────────────────
--
-- La tienda inserta el pedido, luego los ítems, y al final actualiza el
-- subtotal: cuando el disparador corre en ese `update`, los ítems YA existen y
-- se calcula por línea.
--
-- El bot y el mostrador insertan el pedido CON su importe y los ítems después:
-- ahí no hay líneas que mirar y se calcula sobre el subtotal. No es una
-- inconsistencia — es el mismo importe salvo céntimos de redondeo, y en esos
-- caminos el cliente nunca vio un precio unitario con margen.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.


-- ── 1. `on_top` solo con porcentaje y sin límites ──────────────────────────
alter table public.pricing_rules
  drop constraint if exists pricing_rules_mode_check;

-- Se mantiene cerrado a `absorbed` hasta que las pantallas pinten el precio
-- con margen; cuando se abra, esta es la forma que tendrá.
alter table public.pricing_rules
  add constraint pricing_rules_mode_check
  check (
    markup_mode = 'absorbed'
    or (
      markup_mode = 'on_top'
      and strategy = 'percentage'
      and min_amount is null
      and max_amount is null
    )
  );

comment on constraint pricing_rules_mode_check on public.pricing_rules is
  'on_top exige porcentaje sin límites: no se puede mostrar precio por producto y recortar el total a la vez.';


-- ── 2. El margen de un pedido, línea por línea ─────────────────────────────
--
-- Devuelve null si el pedido todavía no tiene líneas, para que quien llama
-- sepa que tiene que caer al cálculo sobre el subtotal.
--
-- El precio unitario que se marca es `line_total / quantity`: incluye lo que
-- sumaron las opciones, que es exactamente lo que la app enseñó.
create or replace function public.order_markup_by_line(
  p_order_id   uuid,
  p_percentage numeric
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when count(*) = 0 then null else
    round(sum(
      -- Se redondea DONDE se redondea al mostrarlo: en el precio unitario.
      round((oi.line_total / nullif(oi.quantity, 0)) * (p_percentage / 100.0), 2)
      * oi.quantity
    ), 2)
  end
  from public.order_items oi
  where oi.order_id = p_order_id
    and oi.quantity > 0;
$$;

revoke all on function public.order_markup_by_line(uuid, numeric) from public, anon, authenticated;
grant execute on function public.order_markup_by_line(uuid, numeric) to service_role;


-- ── 3. El sello, ahora consciente del modo ─────────────────────────────────
--
-- ⚠️ Sigue sin recrear `create_storefront_order` ni `set_order_status`. Con
-- `on_top` además AJUSTA `new.total`, que es lo que hace que el cliente pague
-- el precio que vio — y se puede porque el disparador es BEFORE.
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc     jsonb;
  v_base     numeric(10,2);
  v_modo     text;
  v_pct      numeric;
  v_markup   numeric(10,2);
  v_porlinea numeric(10,2);
  v_envio    numeric(10,2);
begin
  -- Lo que el comercio cobra POR LOS PRODUCTOS: sin envío, sin propina.
  v_base := round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0), 2);

  if v_base <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.discount is not distinct from old.discount
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(new.business_id, v_base, new.pricing_rule_id);
  v_markup := (v_calc ->> 'markup')::numeric;
  v_modo := coalesce(v_calc ->> 'markup_mode', 'absorbed');

  -- Con `on_top` el precio se muestra por producto, así que el margen se
  -- calcula por línea o el total no coincidiría con lo que el cliente sumó.
  -- Si el pedido aún no tiene líneas (bot y mostrador) se queda el del
  -- subtotal: en esos caminos nunca se mostró un precio unitario con margen.
  if v_modo = 'on_top' and (v_calc ->> 'strategy') = 'percentage' then
    v_pct := coalesce((
      select percentage from public.pricing_rules
      where id = nullif(v_calc ->> 'rule_id', '')::uuid
    ), 0);
    v_porlinea := public.order_markup_by_line(new.id, v_pct);
    if v_porlinea is not null then
      v_markup := v_porlinea;
    end if;
  end if;

  new.platform_markup      := v_markup;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  if v_modo = 'on_top' then
    -- El comercio conserva su precio ENTERO: es la promesa del modo.
    new.merchant_subtotal := v_base;
    -- Y el margen se suma a lo que paga el cliente. El envío se respeta tal
    -- como lo dejó la función del dinero.
    v_envio := round(coalesce(new.total, 0) - v_base, 2);
    if v_envio < 0 then v_envio := 0; end if;
    new.total := round(v_base + v_markup + v_envio, 2);
  else
    -- `absorbed`: el margen sale del precio del comercio y el cliente paga
    -- lo mismo. El total no se toca.
    new.merchant_subtotal := round(v_base - v_markup, 2);
  end if;

  return new;
end;
$$;
