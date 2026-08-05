-- ============================================================================
-- MOTOR UNIVERSAL DE PRODUCTOS: TIPOS, ESTRATEGIAS DE PRECIO Y PLANTILLAS
--
-- Lo que falta para que la misma miniapp sirva a una pizzería, una heladería y
-- un local de almuerzos SIN tocar código. Hoy el motor de opciones ya sabe
-- exigir, contar y cobrar; lo que no sabe es:
--
--   · qué CLASE de producto está armando (¿un plato? ¿un combo de tres pizzas?)
--   · cómo se COBRA un grupo cuando no es una simple suma
--   · reutilizar una lista de opciones en varios sitios sin duplicarla
--
-- ── 1. `products.product_type` ──────────────────────────────────────────────
-- simple · configurable · combo · daily_menu · weighted
-- No es un `if` disfrazado: la app no pregunta «¿es pizza?», pregunta «¿este
-- producto se arma eligiendo otros productos?». Un combo de hamburguesas y uno
-- de pizzas recorren exactamente el mismo camino.
--
-- ── 2. `option_groups.pricing_strategy` ─────────────────────────────────────
-- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y media
-- Hawaiana ($9) costarían $19 — el doble de una pizza. Con `highest_selected`
-- se cobra $10, que es como lo hace el negocio de verdad.
--
--   sum                    cada opción suma su recargo (lo de hoy)
--   fixed                  el grupo no altera el precio
--   highest_selected       manda la opción más cara (mitad y mitad)
--   lowest_selected        manda la más barata
--   average                el promedio de lo elegido
--   included               incluido: no suma aunque las opciones tengan precio
--   included_up_to_limit   las primeras N gratis, el resto suma
--   extra_after_limit      igual, pero el límite lo fija `free_selections`
--
-- ── 3. Plantillas de opciones ───────────────────────────────────────────────
-- «Sabores de pizza» se define UNA vez y se usa en la primera pizza, la
-- segunda, la tercera y las dos mitades. Sin esto, un combo de tres pizzas
-- obliga al dueño a escribir la misma lista de 19 sabores cinco veces, y a
-- repetirlas todas cada vez que añada un sabor nuevo.
--
-- Las plantillas NO se copian al grupo: se referencian. Añadir un sabor a la
-- plantilla lo añade a los cinco sitios a la vez, que es justo lo que el dueño
-- espera y lo que hace que el catálogo sea mantenible.
--
-- Idempotente. Aditiva. Sin pérdida de datos.
-- ============================================================================

-- ── 1. La clase de producto ─────────────────────────────────────────────────
alter table public.products
  add column if not exists product_type text not null default 'simple';
alter table public.products
  add column if not exists preparation_time integer;
alter table public.products
  add column if not exists featured boolean not null default false;
alter table public.products
  add column if not exists popular boolean not null default false;
alter table public.products
  add column if not exists sort integer not null default 0;
-- Stock por unidades, para quien lo lleve. `stock` (texto) sigue mandando
-- cuando esto está apagado: no se toca lo que ya funciona.
alter table public.products
  add column if not exists stock_control_enabled boolean not null default false;
alter table public.products
  add column if not exists stock_quantity integer;
alter table public.products
  add column if not exists min_quantity integer not null default 1;
alter table public.products
  add column if not exists max_quantity integer not null default 99;
-- Disponibilidad por día y hora: el almuerzo del día, el desayuno hasta las 11.
alter table public.products
  add column if not exists available_days smallint[];
alter table public.products
  add column if not exists available_from time;
alter table public.products
  add column if not exists available_until time;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass and conname = 'products_motor_check'
  ) then
    alter table public.products add constraint products_motor_check check (
      product_type in ('simple', 'configurable', 'combo', 'daily_menu', 'weighted')
      and (preparation_time is null or preparation_time between 0 and 1440)
      and (stock_quantity is null or stock_quantity >= 0)
      and min_quantity between 1 and 99
      and max_quantity between 1 and 99
      and min_quantity <= max_quantity
      and sort between 0 and 9999
      -- Un día fuera de 0..6 no lo entiende nadie, y dejaría el producto
      -- invisible sin decir por qué.
      and (available_days is null or (
        array_length(available_days, 1) between 1 and 7
        and available_days <@ array[0,1,2,3,4,5,6]::smallint[]
      ))
    );
  end if;
end $$;

create index if not exists idx_products_tipo
  on public.products (business_id, product_type) where active;

-- ── 2. Cómo se cobra un grupo ───────────────────────────────────────────────
alter table public.option_groups
  add column if not exists pricing_strategy text not null default 'sum';
-- Cuántas selecciones van sin recargo antes de empezar a cobrar.
alter table public.option_groups
  add column if not exists free_selections integer not null default 0;
-- Tope de porciones del grupo entero en los contadores, cuando el tope por
-- opción no basta: «4 porciones» repartidas como se quiera.
alter table public.option_groups
  add column if not exists max_total_quantity integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'option_groups_precio_check'
  ) then
    alter table public.option_groups add constraint option_groups_precio_check check (
      pricing_strategy in (
        'sum', 'fixed', 'highest_selected', 'lowest_selected', 'average',
        'included', 'included_up_to_limit', 'extra_after_limit'
      )
      and free_selections between 0 and 100
      and (max_total_quantity is null or max_total_quantity between 1 and 100)
      -- Las dos estrategias con límite necesitan saber cuál es. Sin esto, un
      -- «las primeras N gratis» con N=0 cobraría todo y nadie sabría por qué.
      and (
        pricing_strategy not in ('included_up_to_limit', 'extra_after_limit')
        or free_selections >= 1
      )
    );
  end if;
end $$;

-- ── 3. Plantillas de opciones reutilizables ─────────────────────────────────
create table if not exists public.option_templates (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint option_templates_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
  )
);

create index if not exists idx_option_templates_negocio
  on public.option_templates (business_id, name);
-- El único (id, business_id) va ANTES que cualquier foránea compuesta que lo
-- use como destino: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_templates_id_business
  on public.option_templates (id, business_id);
create unique index if not exists uq_option_templates_nombre
  on public.option_templates (business_id, lower(btrim(name)));

create table if not exists public.option_template_items (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  option_template_id    uuid not null,
  name                  text not null,
  description           text,
  image_url             text,
  image_public_id       text,
  price_adjustment      numeric(10,2) not null default 0,
  references_product_id uuid,
  default_selected      boolean not null default false,
  stock                 text not null default 'disponible',
  sort                  integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint option_template_items_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and price_adjustment >= -100000 and price_adjustment <= 100000
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
    and (image_url is null or image_url ~ '^https://')
  )
);

-- Las dos foráneas van por PAREJA (id, business_id). Una de una sola columna
-- comprueba «esa fila existe», no «esa fila es de este negocio», y ahí es por
-- donde se cruzó la frontera con `product_variants` el 2026-08-02.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_template_items'::regclass
      and conname = 'fk_option_template_items_plantilla_del_negocio'
  ) then
    alter table public.option_template_items
      add constraint fk_option_template_items_plantilla_del_negocio
      foreign key (option_template_id, business_id)
      references public.option_templates (id, business_id) on delete cascade;
  end if;

  -- Una plantilla de «sabores» puede apuntar a productos reales del catálogo:
  -- así los combos eligen pizzas de verdad. `set null` con la columna NOMBRADA,
  -- porque sin nombrarla PostgreSQL anularía también `business_id`, que es NOT
  -- NULL, y borrar un producto reventaría. Es el fallo del 2026-08-02.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_template_items'::regclass
      and conname = 'fk_option_template_items_producto_del_negocio'
  ) then
    alter table public.option_template_items
      add constraint fk_option_template_items_producto_del_negocio
      foreign key (references_product_id, business_id)
      references public.products (id, business_id)
      on delete set null (references_product_id);
  end if;
end $$;

create index if not exists idx_option_template_items_plantilla
  on public.option_template_items (business_id, option_template_id, sort);

-- El grupo que se sirve de una plantilla en vez de tener opciones propias.
alter table public.option_groups
  add column if not exists option_template_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_plantilla_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_plantilla_del_negocio
      foreign key (option_template_id, business_id)
      references public.option_templates (id, business_id)
      on delete set null (option_template_id);
  end if;
end $$;

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
alter table public.option_templates enable row level security;
alter table public.option_template_items enable row level security;
revoke all on table public.option_templates from public, anon, authenticated;
revoke all on table public.option_template_items from public, anon, authenticated;
grant select, insert, update, delete on table public.option_templates to service_role;
grant select, insert, update, delete on table public.option_template_items to service_role;

-- ── 5. Los productos que ya existen ─────────────────────────────────────────
-- Un producto que YA tiene grupos de opciones es `configurable`; el resto se
-- queda en `simple`. Nadie tiene que ir a marcarlos a mano, y ningún producto
-- cambia de comportamiento: `simple` y `configurable` recorren el mismo camino.
update public.products p
set product_type = 'configurable'
where p.product_type = 'simple'
  and (
    exists (
      select 1 from public.option_groups og
      where og.business_id = p.business_id and og.active
        and (og.product_id = p.id or og.category_id = p.category_id)
    )
    or exists (
      select 1 from public.product_variants pv
      where pv.business_id = p.business_id and pv.product_id = p.id and pv.active
    )
  );

-- ── Comprobación inmediata ──────────────────────────────────────────────────
do $comprobacion$
declare
  v_a uuid; v_b uuid; v_pa uuid; v_pb uuid; v_ta uuid; v_tb uuid; v_g uuid;
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('motor-prod-a', 'A', 'pizzería', 'ycloud', '+593900777101', '+593900777101', true)
  returning id into v_a;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('motor-prod-b', 'B', 'pizzería', 'ycloud', '+593900777102', '+593900777102', true)
  returning id into v_b;

  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Pizza de A', 10, 'disponible', true) returning id into v_pa;
  insert into products (business_id, name, price, stock, active)
  values (v_b, 'Pizza de B', 10, 'disponible', true) returning id into v_pb;

  insert into option_templates (business_id, name) values (v_a, 'Sabores')
  returning id into v_ta;
  insert into option_templates (business_id, name) values (v_b, 'Sabores de B')
  returning id into v_tb;

  -- FRONTERA 1: A no puede meter items en la plantilla de B.
  begin
    insert into option_template_items (business_id, option_template_id, name)
    values (v_a, v_tb, 'Hawaiana');
    raise exception 'FUGA: A metió una opción en la plantilla de B';
  exception when foreign_key_violation then null;
  end;

  -- FRONTERA 2: una plantilla de A no puede apuntar a un producto de B.
  begin
    insert into option_template_items (business_id, option_template_id, name, references_product_id)
    values (v_a, v_ta, 'Pizza ajena', v_pb);
    raise exception 'FUGA: la plantilla de A referenció un producto de B';
  exception when foreign_key_violation then null;
  end;

  -- FRONTERA 3: un grupo de A no puede usar la plantilla de B.
  begin
    insert into option_groups (business_id, product_id, name, option_template_id)
    values (v_a, v_pa, 'Sabor', v_tb);
    raise exception 'FUGA: el grupo de A usó la plantilla de B';
  exception when foreign_key_violation then null;
  end;

  -- El uso legítimo funciona.
  insert into option_template_items (business_id, option_template_id, name, references_product_id)
  values (v_a, v_ta, 'Pizza propia', v_pa);
  insert into option_groups (
    business_id, product_id, name, option_template_id, pricing_strategy
  ) values (v_a, v_pa, 'Primera mitad', v_ta, 'highest_selected')
  returning id into v_g;

  -- REGLA: una estrategia inventada no entra.
  begin
    insert into option_groups (business_id, product_id, name, pricing_strategy)
    values (v_a, v_pa, 'Roto', 'lo_que_sea');
    raise exception 'Se admitió una estrategia de precio inventada';
  exception when check_violation then null;
  end;

  -- REGLA: «las primeras N gratis» sin N no significa nada.
  begin
    insert into option_groups (business_id, product_id, name, pricing_strategy, free_selections)
    values (v_a, v_pa, 'Roto', 'included_up_to_limit', 0);
    raise exception 'Se admitió un límite de gratuitas igual a cero';
  exception when check_violation then null;
  end;

  -- REGLA: un tipo de producto inventado tampoco.
  begin
    insert into products (business_id, name, price, stock, active, product_type)
    values (v_a, 'Roto', 5, 'disponible', true, 'pizza');
    raise exception 'Se admitió un product_type inventado';
  exception when check_violation then null;
  end;

  -- REGLA: un día de la semana fuera de rango dejaría el producto invisible.
  begin
    insert into products (business_id, name, price, stock, active, available_days)
    values (v_a, 'Roto', 5, 'disponible', true, array[9]::smallint[]);
    raise exception 'Se admitió un día de la semana fuera de 0..6';
  exception when check_violation then null;
  end;

  -- Borrar la plantilla deja el grupo vivo y sin ella, en vez de reventar.
  delete from option_templates where id = v_ta;
  if not exists (select 1 from option_groups where id = v_g and option_template_id is null) then
    raise exception 'Borrar la plantilla no dejó el grupo en un estado usable';
  end if;

  delete from businesses where id in (v_a, v_b);
  raise notice 'MOTOR DE PRODUCTOS: tipos, estrategias y plantillas comprobados';
end;
$comprobacion$;
