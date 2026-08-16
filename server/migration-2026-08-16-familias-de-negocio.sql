-- ═══════════════════════════════════════════════════════════════════════════
-- FAMILIAS DE NEGOCIO: UNA REGLA PARA TODA LA COMIDA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hoy hay **52 tipos y cada uno es una isla**. Una regla para `restaurante` no
-- alcanza a `pizzería`, ni a `almuerzos`, ni a `batidos`. Para cobrarle lo
-- mismo a toda la comida había que crear **24 reglas iguales**, y una más por
-- cada tipo que se añadiera después.
--
-- Lo destapó el dueño de la plataforma probándolo: creó una regla para
-- `restaurante` y Monster Pizza —tipo `pizzería`— no la cogió.
--
-- En `business-types.ts` hay un comentario `── Comida ──` que agrupa
-- VISUALMENTE, pero no es un dato: el sistema no sabía que una pizzería y una
-- hamburguesería son lo mismo comercialmente.
--
-- ── LA JERARQUÍA PASA A CUATRO NIVELES ────────────────────────────────────
--
--     negocio  >  tipo  >  FAMILIA  >  toda la plataforma
--
-- Y con eso se puede decir lo que antes no:
--
--   · «Toda la comida al 8 %»              → una regla, cubre 24 tipos
--   · «Menos las pizzerías, al 6 %»        → regla de tipo, gana sobre la familia
--   · «Menos este local, al 5 %»           → regla de negocio, gana sobre todo
--
-- ── POR QUÉ DOS TABLAS Y NO UNA COLUMNA EN `businesses` ───────────────────
--
-- La familia es del TIPO, no del negocio. Si fuera una columna del negocio,
-- cada alta tendría que elegirla —o adivinarla— y dos pizzerías podrían acabar
-- en familias distintas. Colgándola del tipo, un negocio nuevo hereda su
-- familia por el tipo que ya elige el superadmin, sin un paso más.
--
-- ⚠️ Un tipo SIN familia (los personalizados que el panel permite escribir a
-- mano) simplemente no encuentra regla de familia y cae a la global. Falla
-- ABIERTO a propósito: un tipo raro no puede dejar a un negocio sin poder
-- vender.
--
-- ⚠️ Sin `begin`/`commit`: la transacción la abre el ejecutor.


-- ── 1. Las familias ────────────────────────────────────────────────────────
--
-- Catálogo de la plataforma, sin `business_id`, como `payment_methods`.
create table if not exists public.business_families (
  code       text primary key,
  label      text not null,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),

  constraint business_families_code_check  check (code ~ '^[a-z_]{3,30}$'),
  constraint business_families_label_check check (char_length(btrim(label)) between 1 and 60),
  constraint business_families_sort_check  check (sort >= 0 and sort <= 999)
);

alter table public.business_families enable row level security;

insert into public.business_families (code, label, sort) values
  ('comida',        'Comida',            10),
  ('retail',        'Tiendas y retail',  20),
  ('hospedaje',     'Hospedaje',         30),
  ('servicios',     'Servicios',         40),
  ('salud_belleza', 'Salud y belleza',   50)
on conflict (code) do nothing;


-- ── 2. A qué familia pertenece cada tipo ───────────────────────────────────
create table if not exists public.business_type_families (
  business_type text primary key,
  family_code   text not null references public.business_families(code) on delete restrict,
  updated_at    timestamptz not null default now()
);

alter table public.business_type_families enable row level security;

create index if not exists idx_business_type_families_familia
  on public.business_type_families (family_code);

-- Los 52 tipos del desplegable, clasificados. Si mañana se añade uno al panel
-- y no se clasifica aquí, cae a la regla global: no rompe nada, solo no hereda.
insert into public.business_type_families (business_type, family_code) values
  -- Comida preparada: 24 tipos que hasta hoy necesitaban 24 reglas iguales.
  ('pizzería','comida'), ('restaurante','comida'), ('cafetería','comida'),
  ('hamburguesería','comida'), ('comida rápida','comida'), ('almuerzos','comida'),
  ('menú ejecutivo','comida'), ('comida típica','comida'), ('desayunos','comida'),
  ('asadero','comida'), ('parrillada','comida'), ('pollo asado','comida'),
  ('marisquería','comida'), ('sushi','comida'), ('comida mexicana','comida'),
  ('comida china','comida'), ('comida saludable','comida'), ('heladería','comida'),
  ('pastelería','comida'), ('postres','comida'), ('batidos','comida'),
  ('jugos','comida'), ('emprendimiento de comida','comida'), ('panadería','comida'),

  -- Retail: se compra producto, no plato preparado. La carnicería va aquí
  -- porque se comporta como tienda —se venden ingredientes al peso— y no como
  -- cocina, aunque el producto sea comida.
  ('tienda','retail'), ('perfumería','retail'), ('farmacia','retail'),
  ('ferretería','retail'), ('supermercado','retail'), ('carnicería','retail'),

  ('hotel','hospedaje'), ('hostal','hospedaje'), ('alojamiento','hospedaje'),
  ('complejo turístico','hospedaje'), ('resort','hospedaje'), ('cabañas','hospedaje'),

  ('negocio','servicios'), ('inmobiliaria','servicios'),
  ('taller automotriz','servicios'), ('servicios profesionales','servicios'),
  ('gimnasio','servicios'),

  ('barbería','salud_belleza'), ('peluquería','salud_belleza'),
  ('salón de belleza','salud_belleza'), ('spa','salud_belleza'),
  ('centro de estética','salud_belleza'), ('clínica','salud_belleza'),
  ('consultorio','salud_belleza'), ('odontología','salud_belleza'),
  ('psicología','salud_belleza'), ('fisioterapia','salud_belleza'),
  ('masajes','salud_belleza')
on conflict (business_type) do nothing;


-- ── 3. Las reglas admiten ámbito de familia ────────────────────────────────
alter table public.pricing_rules
  drop constraint if exists pricing_rules_scope_check;

alter table public.pricing_rules
  add constraint pricing_rules_scope_check
  check (scope in ('global', 'family', 'business_type', 'business'));

-- Cada ámbito sigue exigiendo exactamente sus datos: una regla de familia sin
-- familia se aplicaría a toda la plataforma sin que nadie lo pidiera.
alter table public.pricing_rules
  drop constraint if exists pricing_rules_destino_check;

alter table public.pricing_rules
  add constraint pricing_rules_destino_check check (
    (scope = 'global'        and business_id is null     and target_name is null)
    or
    (scope = 'family'        and business_id is null     and target_name is not null)
    or
    (scope = 'business_type' and business_id is null     and target_name is not null)
    or
    (scope = 'business'      and business_id is not null and target_name is null)
  );

-- Una sola regla activa por familia, igual que por tipo y por negocio: dos
-- dejarían el margen a merced del orden de lectura.
create unique index if not exists idx_pricing_rules_activa_familia
  on public.pricing_rules (target_name)
  where scope = 'family' and status = 'active';


-- ── 4. La resolución, ahora con cuatro niveles ─────────────────────────────
--
-- Se recrea `calculate_platform_markup` —es una función propia del motor, no
-- una de las del dinero que no se tocan— para añadir el nivel de familia. El
-- resto del cuerpo es idéntico.
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

  if v_base <= 0 then
    return jsonb_build_object(
      'markup', 0, 'rule_id', null, 'rule_version', null,
      'markup_mode', 'absorbed', 'strategy', null
    );
  end if;

  if p_rule_id is not null then
    -- Regla congelada: se usa aunque hoy esté archivada o vencida.
    select * into v_regla from public.pricing_rules where id = p_rule_id;
  else
    -- Prioridad: negocio → tipo → FAMILIA → global. La primera que haya.
    select pr.* into v_regla
    from public.pricing_rules pr
    left join public.businesses b on b.id = p_business_id
    left join public.business_type_families f on f.business_type = b.type
    where pr.status = 'active'
      and pr.effective_from <= now()
      and (pr.effective_until is null or pr.effective_until > now())
      and (
        (pr.scope = 'business'      and pr.business_id = p_business_id)
        or (pr.scope = 'business_type' and pr.target_name = b.type)
        or (pr.scope = 'family'        and pr.target_name = f.family_code)
        or (pr.scope = 'global')
      )
    order by case pr.scope
               when 'business'      then 1
               when 'business_type' then 2
               when 'family'        then 3
               when 'global'        then 4
             end
    limit 1;
  end if;

  -- FALLA ABIERTO: sin regla no hay margen y el pedido sigue. Un problema de
  -- configuración de precios no puede dejar a una pizzería sin poder vender.
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
    -- Ordenado por `up_to` y no por el orden del array: uno mal ordenado en el
    -- panel cobraría el tramo equivocado sin avisar.
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

  -- El piso ANTES que el techo: manda el que protege al comercio.
  if v_regla.min_amount is not null then
    v_markup := greatest(v_markup, v_regla.min_amount);
  end if;
  if v_regla.max_amount is not null then
    v_markup := least(v_markup, v_regla.max_amount);
  end if;

  -- Raíles que no dependen de la configuración: nunca negativo, y nunca más
  -- que el subtotal.
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


-- ── 5. La familia de un negocio, para el panel ─────────────────────────────
create or replace function public.business_family(p_business_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select f.family_code
  from public.businesses b
  join public.business_type_families f on f.business_type = b.type
  where b.id = p_business_id;
$$;

revoke all on function public.business_family(uuid) from public, anon, authenticated;
grant execute on function public.business_family(uuid) to service_role;
