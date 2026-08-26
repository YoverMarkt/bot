-- ============================================================================
-- EL MARGEN SE SUMA AL PRECIO, NO SE LE QUITA AL DUEÑO
--
-- Corrección del modelo económico pedida por el dueño el 2026-08-25.
--
-- HASTA HOY (`absorbed`), sobre un pedido de $8:
--   · el cliente pagaba          $8,00
--   · el comercio recibía        $7,20   ← se le descontaba el 10%
--   · la plataforma se quedaba   $0,80
--
-- Y no es lo que el negocio quiere ser. Los datos de producción lo enseñan:
-- en 5 pedidos los clientes pagaron $64,95 y el comercio recibió $47,25.
-- El dueño de un local pone el precio al que QUIERE VENDER; quitarle una
-- parte lo convierte en un descuento forzoso que él no pactó.
--
-- DESDE HOY (`on_top`), sobre el mismo pedido de $8:
--   · el comercio recibe         $8,00   ← su precio, entero
--   · la plataforma suma         $0,80
--   · el cliente paga            $8,80  (+ envío aparte)
--
-- ⚠️ `on_top` YA ESTABA IMPLEMENTADO en `services/platform-pricing.ts` desde
-- el 2026-08-16, y un CHECK lo impedía a propósito con esta nota: «exige que
-- el catálogo, el carrito y el resumen pinten el precio con margen; hasta
-- entonces el CHECK lo impide». Esta migración llega ACOMPAÑADA de esos tres
-- cambios, así que la condición se cumple y el freno se puede levantar. No se
-- levanta antes de tiempo: se levanta cuando lo que exigía existe.
--
-- ⚠️ LOS PEDIDOS VIEJOS NO CAMBIAN. `orders_stamp_pricing` recalcula con la
-- regla SELLADA en el pedido (`pricing_rule_id`), no con la vigente hoy, y
-- esta migración no toca ninguna fila de `orders`. Los 5 pedidos ya cobrados
-- siguen contando su margen absorbido, que es lo que de verdad ocurrió.
--
-- ⚠️ EL SUBTOTAL SIGUE SIENDO EL DEL COMERCIO. `orders.subtotal` no cambia de
-- significado: es lo que el local pone por sus productos, y con `on_top` es
-- exactamente su liquidación. Lo que sube es `total`, que es lo que paga el
-- cliente. Guardar el subtotal ya inflado obligaría a dividir hacia atrás para
-- saber cuánto cobra el comercio, y una división con redondeo deja de cuadrar.
--
-- ⚠️ UN SOLO REDONDEO. El margen se calcula sobre el subtotal completo y se
-- redondea una vez, nunca por línea: diez líneas redondeadas por separado se
-- desvían del porcentaje pactado.
-- ============================================================================

-- ── 1. `on_top` deja de estar prohibido ─────────────────────────────────────
alter table public.pricing_rules
  drop constraint if exists pricing_rules_mode_check;

alter table public.pricing_rules
  add constraint pricing_rules_mode_check
  check (markup_mode in ('absorbed', 'on_top'));

comment on column public.pricing_rules.markup_mode is
  '`on_top`: el margen se SUMA al precio y el comercio cobra entero. `absorbed`: se le descuenta. El modelo del negocio es `on_top` desde el 2026-08-25; `absorbed` se conserva porque los pedidos ya sellados con el deben seguir liquidandose como se cobraron.';

-- ── 2. El disparador respeta el modo ────────────────────────────────────────
--
-- ⚠️ Se sigue SIN recrear `create_storefront_order`: el disparador cubre los
-- tres caminos —tienda, bot y mostrador— y cualquiera que se invente después.
-- Es la misma regla que `orders_reject_blocked` y los frenos del #269/#270.
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc jsonb;
  v_modo text;
  v_markup numeric(10,2);
begin
  if coalesce(new.subtotal, 0) <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.shipping is not distinct from old.shipping
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(
    new.business_id,
    new.subtotal,
    new.pricing_rule_id
  );

  v_markup := (v_calc ->> 'markup')::numeric;
  v_modo   := coalesce(v_calc ->> 'markup_mode', 'absorbed');

  -- ⚠️ MOSTRADOR NUNCA lleva margen sumado. Lo teclea el dueño con la persona
  -- delante, cobrando el precio que él dice: subirle el total le haría cobrar
  -- de más a un cliente que vino solo, sin que la plataforma lo trajera. Es el
  -- mismo criterio con el que el mostrador queda fuera de todos los frenos.
  -- Con `absorbed` se mantiene el comportamiento anterior para no cambiar en
  -- silencio la liquidación de un camino que nadie pidió tocar.
  if v_modo = 'on_top' and coalesce(new.source, '') <> 'storefront' then
    v_markup := 0;
  end if;

  if v_modo = 'on_top' then
    -- El comercio cobra su precio ENTERO y el margen se añade al total.
    new.merchant_subtotal := round(new.subtotal, 2);
    new.total := round(new.subtotal + v_markup + coalesce(new.shipping, 0), 2);
  else
    new.merchant_subtotal := round(new.subtotal - v_markup, 2);
  end if;

  new.platform_markup      := v_markup;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  return new;
end;
$$;

drop trigger if exists orders_stamp_pricing on public.orders;
create trigger orders_stamp_pricing
  before insert or update on public.orders
  for each row execute function public.orders_stamp_pricing();

-- ── 3. Qué margen pintar en el catálogo ─────────────────────────────────────
--
-- El catálogo tiene que enseñar el precio que el cliente va a pagar, y para
-- eso necesita el porcentaje vigente ANTES de que exista un pedido. Se
-- devuelve la regla entera —no un número suelto— para que el servidor aplique
-- la MISMA jerarquía (negocio → tipo → global) sin reimplementarla.
--
-- ⚠️ Devuelve `null` si no hay regla vigente: entonces no se pinta margen
-- ninguno y el cliente ve el precio del comercio. Falla hacia NO cobrar de
-- más, que es el lado seguro del error.
create or replace function public.business_pricing_view(
  p_business_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_regla public.pricing_rules%rowtype;
begin
  if p_business_id is null then
    return null;
  end if;

  select pr.* into v_regla
  from public.pricing_rules pr
  join public.businesses b on b.id = p_business_id
  where pr.status = 'active'
    and pr.effective_from <= now()
    and (pr.effective_until is null or pr.effective_until > now())
    and (
      (pr.scope = 'business'      and pr.business_id = p_business_id)
      or (pr.scope = 'business_type' and pr.target_name = b.type)
      or (pr.scope = 'global')
    )
  order by case pr.scope
             when 'business'      then 1
             when 'business_type' then 2
             when 'global'        then 3
           end,
           pr.effective_from desc
  limit 1;

  if v_regla.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'rule_id',     v_regla.id,
    'version',     v_regla.version,
    'mode',        v_regla.markup_mode,
    'strategy',    v_regla.strategy,
    'percentage',  v_regla.percentage,
    'fixed_amount', v_regla.fixed_amount,
    'tiers',       v_regla.tiers,
    'min_amount',  v_regla.min_amount,
    'max_amount',  v_regla.max_amount
  );
end;
$$;

revoke all on function public.business_pricing_view(uuid) from public, anon, authenticated;
grant execute on function public.business_pricing_view(uuid) to service_role;
