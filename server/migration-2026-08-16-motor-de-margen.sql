-- ═══════════════════════════════════════════════════════════════════════════
-- MOTOR DE MARGEN DE LA PLATAFORMA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy la plataforma cobraba UNA sola cosa: la cuota mensual
-- (`businesses.monthly_rate`). Un pedido no le dejaba nada, y por eso no había
-- ni una columna que dijera cuánto de lo que pagó el cliente era nuestro.
--
-- Esto instala el motor que lo calcula. NO cobra un centavo de más a nadie el
-- día que se aplica: sin reglas cargadas el margen es 0 y todo sigue igual.
-- Los porcentajes los enciende el dueño del SaaS desde el panel, negocio por
-- negocio.
--
-- ── POR QUÉ UNA REGLA CONFIGURABLE Y NO UN PORCENTAJE ─────────────────────
--
-- Un restaurante y un supermercado no se pueden cobrar igual, y esa es la
-- razón entera de que esto sea una tabla en vez de un número:
--
--   · Un restaurante trabaja con márgenes amplios. El 10 % de un pedido de
--     $15 son $1.50 y nadie se inmuta.
--   · Un supermercado trabaja al 2–5 %. Cobrarle el 8 % de una canasta de $80
--     serían $6.40 — MÁS de lo que él gana con esa venta. No te firma, y hace
--     bien.
--
-- Por eso hay tres frenos, y cada uno protege a alguien distinto:
--
--   · `max_amount` (TECHO) protege al comercio de volumen. «5 %, máximo $3»:
--     una canasta de $150 paga $3, no $7.50.
--   · `min_amount` (PISO) nos protege a NOSOTROS. Cada pedido cuesta mensajes
--     de WhatsApp —Meta los cobra desde el 1 de octubre de 2026— y llamadas de
--     IA. Un pedido de $2 al 8 % deja $0.16 y puede costar más que eso en
--     mensajes: sin piso, los pedidos pequeños se atienden A PÉRDIDA.
--   · `strategy = 'tiered'` cubre el caso en que ninguno de los dos alcanza.
--
-- ── LO QUE ESTA MIGRACIÓN NO HACE, A PROPÓSITO ────────────────────────────
--
-- El margen se calcula sobre el SUBTOTAL del pedido, una vez. NO por línea.
-- Un margen por producto o por categoría (12 % la comida, 5 % las bebidas) es
-- una función legítima y la tabla ya está preparada para llevarla, pero el
-- cálculo exigiría leer `order_items` desde el disparador — y en el momento en
-- que este se dispara, esas filas todavía no existen en uno de los dos caminos
-- de creación. Hacerlo ahora sería un disparador frágil en el núcleo del
-- dinero para una función que ningún cliente ha pedido.
--
-- Por eso el CHECK de `scope` admite hoy solo los tres niveles que se pueden
-- resolver sobre el subtotal. Falla CERRADO: no se puede guardar una regla que
-- el motor no vaya a honrar. Cuando llegue el margen por línea, la migración
-- ensancha el CHECK y añade `max_per_order`; no hay que rehacer nada.
--
-- ── EL MODO DEL MARGEN ────────────────────────────────────────────────────
--
-- `markup_mode` reconcilia los dos modelos económicos que parecían excluirse:
--
--   · `absorbed`  → el cliente paga $10, el comercio recibe $9, nosotros $1.
--                   Invisible para el cliente final. CERO cambios de pantalla.
--   · `on_top`    → el cliente paga $11, el comercio recibe $10, nosotros $1.
--
-- Mismo cálculo, mismo asiento, misma deuda. Lo único que cambia es si el
-- margen se suma al precio del cliente o se absorbe del precio del comercio.
--
-- ⚠️ Arranca en `absorbed` para todos y el motor NO toca `orders.total`. El
-- día que se encienda `on_top` habrá que pintar el precio con margen en el
-- catálogo, el carrito y el resumen — o el cliente descubriría el precio real
-- al confirmar, que es justo lo que la documentación de este proyecto prohíbe.
-- Ese trabajo es de las tres superficies, no de esta migración.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor
-- (`tests/migraciones.mjs`). Lo vigila `migraciones-guardian.test.js`.


-- ── 1. Las reglas ──────────────────────────────────────────────────────────
--
-- `business_id` nulo significa «regla de toda la plataforma», siguiendo el
-- precedente de `platform_errors`. RLS queda activa y sin políticas: el
-- servidor entra con la service role key y nadie más lee esta tabla.
create table if not exists public.pricing_rules (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid references public.businesses(id) on delete cascade,

  -- A quién aplica. La prioridad NO se guarda: se deriva del scope, para que
  -- no exista la posibilidad de dos reglas con el mismo peso.
  scope            text not null,
  target_name      text,

  -- Cómo cobra.
  strategy         text not null,
  percentage       numeric(7,4),
  fixed_amount     numeric(10,2),
  tiers            jsonb,

  -- Los frenos.
  min_amount       numeric(10,2),
  max_amount       numeric(10,2),

  markup_mode      text not null default 'absorbed',

  -- Versionado (§41): un pedido guarda QUÉ regla y QUÉ versión le aplicaron.
  version          integer not null default 1,
  effective_from   timestamptz not null default now(),
  effective_until  timestamptz,
  status           text not null default 'active',

  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Los tres niveles que se resuelven sobre el subtotal. Ver la cabecera:
  -- 'category' y 'product' entrarán con el margen por línea.
  constraint pricing_rules_scope_check
    check (scope in ('global', 'business_type', 'business')),

  constraint pricing_rules_strategy_check
    check (strategy in ('percentage', 'fixed', 'tiered')),

  constraint pricing_rules_mode_check
    check (markup_mode in ('absorbed', 'on_top')),

  constraint pricing_rules_status_check
    check (status in ('active', 'draft', 'archived')),

  -- Cada scope exige exactamente sus datos. Sin esto, una regla «de negocio»
  -- sin `business_id` se aplicaría a TODA la plataforma sin que nadie lo
  -- pidiera — el error más caro que puede tener esta tabla.
  constraint pricing_rules_destino_check check (
    (scope = 'global'        and business_id is null     and target_name is null)
    or
    (scope = 'business_type' and business_id is null     and target_name is not null)
    or
    (scope = 'business'      and business_id is not null and target_name is null)
  ),

  -- Cada estrategia exige su dato. Una regla `percentage` sin porcentaje
  -- cobraría 0 en silencio, que es peor que no dejar guardarla.
  constraint pricing_rules_datos_check check (
    (strategy = 'percentage' and percentage   is not null and fixed_amount is null and tiers is null)
    or
    (strategy = 'fixed'      and fixed_amount is not null and percentage   is null and tiers is null)
    or
    (strategy = 'tiered'     and tiers        is not null and percentage   is null and fixed_amount is null)
  ),

  constraint pricing_rules_rangos_check check (
    (percentage   is null or (percentage   >= 0 and percentage   <= 100))
    and (fixed_amount is null or (fixed_amount >= 0 and fixed_amount <= 9999))
    and (min_amount   is null or (min_amount   >= 0 and min_amount   <= 9999))
    and (max_amount   is null or (max_amount   >= 0 and max_amount   <= 9999))
    and (min_amount is null or max_amount is null or min_amount <= max_amount)
    and (version >= 1)
    and (effective_until is null or effective_until > effective_from)
  ),

  constraint pricing_rules_tiers_check check (
    tiers is null or jsonb_typeof(tiers) = 'array'
  )
);

alter table public.pricing_rules enable row level security;

-- Una sola regla activa por destino. Sin esto, dos reglas de negocio activas
-- dejarían el margen a merced del orden de lectura: el mismo pedido cobraría
-- distinto según cómo respondiera PostgreSQL ese día.
create unique index if not exists idx_pricing_rules_activa_negocio
  on public.pricing_rules (business_id)
  where scope = 'business' and status = 'active';

create unique index if not exists idx_pricing_rules_activa_tipo
  on public.pricing_rules (target_name)
  where scope = 'business_type' and status = 'active';

create unique index if not exists idx_pricing_rules_activa_global
  on public.pricing_rules ((true))
  where scope = 'global' and status = 'active';


-- ── 2. Lo que el pedido congela ────────────────────────────────────────────
--
-- Se copian AL PEDIDO en vez de consultarse al leerlo, por lo mismo que se
-- copió la dirección: el panel del dueño pide sus pedidos cada 12 segundos, y
-- unirse a `pricing_rules` en esa consulta correría sin parar durante todo el
-- servicio.
--
-- Consecuencia deliberada (§41): cambiar el porcentaje mañana NO reescribe el
-- margen de los pedidos de hoy, igual que cambiar un precio no reescribe lo
-- ya cobrado.
alter table public.orders
  add column if not exists merchant_subtotal    numeric(10,2),
  add column if not exists platform_markup      numeric(10,2),
  add column if not exists pricing_rule_id      uuid,
  add column if not exists pricing_rule_version integer;

-- Sin clave foránea a `pricing_rules` A PROPÓSITO: si alguien borra una regla,
-- el pedido tiene que conservar el rastro de cuál le aplicaron. Una foránea
-- con `set null` borraría justo la prueba, y con `restrict` volvería
-- imborrable una regla de hace dos años.
comment on column public.orders.pricing_rule_id is
  'Regla de margen aplicada. Sin FK: es un rastro histórico, no un puntero vivo.';


-- ── 3. El cálculo ──────────────────────────────────────────────────────────
--
-- Resuelve la regla y aplica la estrategia en UNA función, para que no exista
-- la posibilidad de resolver con una y cobrar con otra.
--
-- `p_rule_id` fuerza una regla ya congelada: así un pedido que se recalcula
-- (una sustitución, un producto agotado) sigue usando la regla que le tocó al
-- nacer y no la que esté vigente hoy.
--
-- Devuelve jsonb en vez de columnas sueltas porque quien lo llama —el
-- disparador y el panel— necesita el importe Y la trazabilidad juntos.
create or replace function public.calculate_platform_markup(
  p_business_id uuid,
  p_subtotal    numeric,
  p_rule_id     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_regla   public.pricing_rules%rowtype;
  v_base    numeric(10,2);
  v_markup  numeric(10,2) := 0;
  v_tier    jsonb;
  v_tipo    text;
begin
  v_base := round(coalesce(p_subtotal, 0), 2);

  -- Un pedido sin importe no genera margen. Cortar aquí evita que un
  -- subtotal negativo (una devolución mal registrada) produzca un margen
  -- negativo que luego habría que perseguir en el ledger.
  if v_base <= 0 then
    return jsonb_build_object(
      'markup', 0, 'rule_id', null, 'rule_version', null,
      'markup_mode', 'absorbed', 'strategy', null
    );
  end if;

  if p_rule_id is not null then
    -- Regla congelada: se usa aunque hoy esté archivada o vencida. Ese es
    -- justo el punto de congelarla.
    select * into v_regla from public.pricing_rules where id = p_rule_id;
  else
    -- Prioridad §6: negocio → tipo de negocio → global. La primera que haya.
    select pr.* into v_regla
    from public.pricing_rules pr
    left join public.businesses b on b.id = p_business_id
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
             end
    limit 1;
  end if;

  -- FALLA ABIERTO. Sin regla no hay margen y el pedido sigue su camino. Un
  -- problema de configuración de precios no puede dejar a una pizzería sin
  -- poder vender: equivocarse por defecto cuesta una comisión; equivocarse al
  -- revés cuesta el servicio entero de ese día.
  if v_regla.id is null then
    return jsonb_build_object(
      'markup', 0, 'rule_id', null, 'rule_version', null,
      'markup_mode', 'absorbed', 'strategy', null
    );
  end if;

  if v_regla.strategy = 'percentage' then
    v_markup := v_base * v_regla.percentage / 100.0;

  elsif v_regla.strategy = 'fixed' then
    v_markup := v_regla.fixed_amount;

  elsif v_regla.strategy = 'tiered' then
    -- El primer tramo cuyo techo alcanza al subtotal. Se recorre ordenado por
    -- `up_to` y no por el orden del array: un array mal ordenado en el panel
    -- cobraría el tramo equivocado sin avisar.
    for v_tier in
      select value
      from jsonb_array_elements(v_regla.tiers) as value
      order by coalesce((value ->> 'up_to')::numeric, 'infinity'::numeric)
    loop
      v_tipo := v_tier ->> 'up_to';
      if v_tipo is null or v_base <= v_tipo::numeric then
        v_markup := coalesce((v_tier ->> 'amount')::numeric, 0);
        exit;
      end if;
    end loop;
  end if;

  -- El piso ANTES que el techo: con «mínimo $0.50, máximo $0.30» mal
  -- configurados manda el techo, que es el que protege al comercio. El CHECK
  -- ya impide guardar esa combinación, pero el orden importa si algún día se
  -- relaja.
  if v_regla.min_amount is not null then
    v_markup := greatest(v_markup, v_regla.min_amount);
  end if;
  if v_regla.max_amount is not null then
    v_markup := least(v_markup, v_regla.max_amount);
  end if;

  -- Dos raíles que no dependen de la configuración: nunca negativo, y nunca
  -- más que el propio subtotal. Un piso de $5 sobre un pedido de $2 no puede
  -- dejar al comercio debiendo dinero por haber vendido.
  v_markup := greatest(v_markup, 0);
  v_markup := least(v_markup, v_base);

  return jsonb_build_object(
    'markup',       round(v_markup, 2),
    'rule_id',      v_regla.id,
    'rule_version', v_regla.version,
    'markup_mode',  v_regla.markup_mode,
    'strategy',     v_regla.strategy
  );
end;
$$;

revoke all on function public.calculate_platform_markup(uuid, numeric, uuid)
  from public, anon, authenticated;
grant execute on function public.calculate_platform_markup(uuid, numeric, uuid)
  to service_role;


-- ── 4. El sello ────────────────────────────────────────────────────────────
--
-- ⚠️ NO se recrean `create_storefront_order` ni `set_order_status`. Es el
-- mismo criterio que ya siguió `orders_reject_blocked`: recrear la función del
-- dinero por un añadido pequeño no compensa el riesgo de copiar la versión
-- equivocada desde `schema.sql`, donde conviven varias definiciones.
--
-- Un disparador consigue lo mismo y cubre LOS TRES caminos de una vez —la
-- tienda, el bot y el mostrador— además de cualquiera que se invente después,
-- sin que nadie tenga que acordarse de llamarlo.
--
-- Es BEFORE para poder escribir en `new` sin provocar una segunda escritura
-- (un AFTER tendría que hacer su propio `update` y volvería a dispararse).
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc jsonb;
begin
  -- Solo cuando hay un subtotal que valga la pena. `create_storefront_order`
  -- inserta el pedido con subtotal 0 y lo actualiza al final: sin esta
  -- condición se sellaría un margen de 0 en la inserción y no volvería a
  -- mirarse.
  if coalesce(new.subtotal, 0) <= 0 then
    return new;
  end if;

  -- En UPDATE, solo si el subtotal se movió de verdad. El panel actualiza
  -- estos pedidos muchas veces (estado, aviso, comprobante) y recalcular en
  -- cada una sería trabajo tirado.
  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  -- La regla se resuelve UNA vez y se conserva. Si el pedido ya la tiene
  -- sellada, se recalcula el importe con ESA regla y no con la vigente hoy:
  -- un pedido de febrero no puede empezar a cobrar el porcentaje de marzo
  -- porque alguien le cambió el estado (§41).
  v_calc := public.calculate_platform_markup(
    new.business_id,
    new.subtotal,
    new.pricing_rule_id
  );

  new.merchant_subtotal    := round(new.subtotal - (v_calc ->> 'markup')::numeric, 2);
  new.platform_markup      := (v_calc ->> 'markup')::numeric;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  return new;
end;
$$;

-- Va DESPUÉS de `orders_reject_blocked` por orden alfabético de nombre, que es
-- como PostgreSQL los ordena. Es lo correcto: no tiene sentido calcular el
-- margen de un pedido que va a ser rechazado.
drop trigger if exists orders_stamp_pricing on public.orders;
create trigger orders_stamp_pricing
  before insert or update on public.orders
  for each row execute function public.orders_stamp_pricing();


-- ── 5. Los pedidos que ya existen ──────────────────────────────────────────
--
-- Se les rellena `merchant_subtotal` con su subtotal y el margen en 0: es
-- exactamente lo que ocurrió: no se les cobró nada. Dejarlos en null obligaría
-- a que cada consulta futura tuviera que distinguir «sin margen» de «todavía
-- sin calcular», que son la misma cosa para todo pedido anterior a hoy.
update public.orders
set merchant_subtotal = subtotal,
    platform_markup   = 0
where merchant_subtotal is null;
