-- ============================================================================
-- MOTOR DE GRUPOS DE OPCIONES
--
-- Es la pieza que convierte el catálogo en un motor genérico: lo que hoy hace
-- falta escribir a mano para cada tipo de negocio pasa a ser configuración.
--
-- Hasta ahora había `menu_modifiers`, que es una lista plana de extras con
-- recargo agrupada por `group_label`. Sirve para «agrega queso +$1.50», y se
-- queda corta en cuanto el negocio necesita:
--
--   · un grupo OBLIGATORIO      → «elige el tamaño» antes de poder pedir
--   · un MÍNIMO                 → «elige de 1 a 3 frutas»
--   · elegir por CANTIDAD       → «4 porciones: 2 de lomo, 1 chorizo, 1 pollo»
--   · una opción que ES un producto → los combos
--
-- Sin esas cuatro cosas no existen los almuerzos (sopa + segundo + guarnición
-- + bebida, todo obligatorio), ni las parrilladas, ni los batidos, ni un combo
-- de dos pizzas. Con ellas, dar de alta una hamburguesería es cargar datos.
--
-- ── Qué NO hace esta migración ──────────────────────────────────────────────
-- No borra `menu_modifiers` ni toca sus 19 filas. Las copia. La tabla vieja
-- queda intacta y en uso hasta que el código nuevo esté desplegado y
-- verificado; retirarla es una migración aparte y consciente.
--
-- Idempotente. Aditiva. Sin pérdida de datos.
-- ============================================================================

-- ── 1. Los grupos ───────────────────────────────────────────────────────────
create table if not exists public.option_groups (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  product_id       uuid not null,
  name             text not null,
  description      text,
  -- Qué se puede hacer dentro del grupo. Son los tres selectores reales:
  --   single   → un radio. Tamaño de pizza, término de la carne.
  --   multiple → casillas con tope. Ingredientes, salsas.
  --   quantity → cada opción con su contador. Cortes de una parrillada.
  selection_type   text not null default 'single',
  required         boolean not null default false,
  min_selectable   integer not null default 0,
  max_selectable   integer not null default 1,
  sort             integer not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint option_groups_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and selection_type in ('single', 'multiple', 'quantity')
    and min_selectable >= 0 and min_selectable <= 100
    and max_selectable >= 1 and max_selectable <= 100
    and min_selectable <= max_selectable
    -- Un grupo obligatorio sin mínimo no obliga a nada: sería un botón de
    -- «obligatorio» que no impide seguir, que es peor que no ponerlo.
    and (required = false or min_selectable >= 1)
    -- `single` es exactamente uno. Sin esto se podría guardar un radio con
    -- max 5, y la app tendría que decidir a quién cree.
    and (selection_type <> 'single' or max_selectable = 1)
    and sort between 0 and 999
  )
);

-- El producto se referencia por PAREJA (id, business_id), no solo por id.
-- Una foránea de una sola columna comprueba «esa fila existe», no «esa fila es
-- de este negocio», y como el negocio sale del JWT mientras el otro id viaja
-- en la petición, ahí se cruza la frontera mandando un uuid ajeno. Fue lo que
-- pasó con `product_variants` y `products.category_id` el 2026-08-02.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_producto_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_producto_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_option_groups_producto
  on public.option_groups (business_id, product_id, sort);

-- El único (id, business_id) tiene que existir ANTES que la foránea compuesta
-- que lo usa como destino: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_groups_id_business
  on public.option_groups (id, business_id);

-- ── 2. Las opciones ─────────────────────────────────────────────────────────
create table if not exists public.options (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  option_group_id       uuid not null,
  name                  text not null,
  description           text,
  image_url             text,
  image_public_id       text,
  -- Puede ser NEGATIVO: «sin sopa −$0.50» en un almuerzo es un caso real.
  -- Por eso el importe final lo calcula PostgreSQL y nunca el navegador.
  price_adjustment      numeric(10,2) not null default 0,
  -- Aquí viven los COMBOS: una opción que ES un producto del catálogo.
  -- «Elige tu 1era pizza» son opciones que apuntan a pizzas reales, en vez de
  -- columnas fijas tipo pizza_1, pizza_2.
  references_product_id uuid,
  default_selected      boolean not null default false,
  stock                 text not null default 'disponible',
  sort                  integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint options_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and price_adjustment >= -100000 and price_adjustment <= 100000
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
    and (image_url is null or image_url ~ '^https://')
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_grupo_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_grupo_del_negocio
      foreign key (option_group_id, business_id)
      references public.option_groups (id, business_id) on delete cascade;
  end if;

  -- El producto referenciado también tiene que ser de ESTE negocio: si no, un
  -- combo podría incluir la pizza del local de al lado.
  --
  -- `on delete set null (references_product_id)` con la columna NOMBRADA: sin
  -- nombrarla PostgreSQL anularía también `business_id`, que es NOT NULL, y
  -- borrar un producto reventaría. Es exactamente el fallo del 2026-08-02.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_producto_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_producto_del_negocio
      foreign key (references_product_id, business_id)
      references public.products (id, business_id)
      on delete set null (references_product_id);
  end if;
end $$;

create index if not exists idx_options_grupo
  on public.options (business_id, option_group_id, sort);

-- ── 3. Qué eligió el cliente, guardado con el pedido ────────────────────────
-- Fotografía inmutable: si mañana cambia el nombre o el recargo de la opción,
-- el pedido de ayer tiene que seguir diciendo lo que se pidió y lo que costó.
create table if not exists public.order_item_options (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  order_item_id          uuid not null references public.order_items(id) on delete cascade,
  option_group_id        uuid,
  option_id              uuid,
  option_group_name      text not null,
  option_name            text not null,
  quantity               integer not null default 1,
  unit_price_adjustment  numeric(10,2) not null default 0,
  total_price_adjustment numeric(10,2) not null default 0,
  created_at             timestamptz not null default now(),
  constraint order_item_options_datos_check check (
    char_length(btrim(option_group_name)) between 1 and 120
    and char_length(btrim(option_name)) between 1 and 120
    and quantity between 1 and 100
  )
);

create index if not exists idx_order_item_options_item
  on public.order_item_options (business_id, order_item_id);

-- `order_item_options` apunta al ítem del pedido, y ambos llevan business_id:
-- con una foránea de una sola columna se podría colgar el detalle de lo que
-- eligió un cliente sobre el ítem de OTRO negocio. Lo cazó
-- `verificar-fronteras.sql` al escribir esta migración, que es justo para lo
-- que se construyó.
create unique index if not exists uq_order_items_id_business
  on public.order_items (id, business_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_item_options'::regclass
      and conname = 'fk_order_item_options_item_del_negocio'
  ) then
    alter table public.order_item_options
      drop constraint if exists order_item_options_order_item_id_fkey;
    alter table public.order_item_options
      add constraint fk_order_item_options_item_del_negocio
      foreign key (order_item_id, business_id)
      references public.order_items (id, business_id) on delete cascade;
  end if;
end $$;

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
-- El frontend nunca habla con Supabase: la anon key queda bloqueada y el
-- aislamiento real lo refuerza el filtrado por business_id en server/src/db.
alter table public.option_groups enable row level security;
alter table public.options enable row level security;
alter table public.order_item_options enable row level security;

revoke all on table public.option_groups from public, anon, authenticated;
revoke all on table public.options from public, anon, authenticated;
revoke all on table public.order_item_options from public, anon, authenticated;
grant select, insert, update, delete on table public.option_groups to service_role;
grant select, insert, update, delete on table public.options to service_role;
grant select, insert, update, delete on table public.order_item_options to service_role;

-- ── 5. Los 19 modificadores que ya existen ──────────────────────────────────
-- Se COPIAN, no se mueven. `menu_modifiers` queda intacta y sigue funcionando
-- hasta que el código nuevo esté verificado en producción.
--
-- El mapeo es honesto sobre lo que se sabe y lo que no:
--   group_label   → nombre del grupo
--   max_selectable → tope (o 1 si no tenía)
--   price_delta   → price_adjustment
-- Y lo que la tabla vieja NO guardaba se pone en el valor MENOS restrictivo:
-- opcional, sin mínimo. Marcar como obligatorio algo que nunca lo fue dejaría
-- productos que no se pueden pedir.
do $$
declare
  v_fila record;
  v_grupo uuid;
  v_copiados integer := 0;
begin
  for v_fila in
    select m.business_id, m.product_id, m.group_label,
           max(coalesce(m.max_selectable, 1)) as tope
    from public.menu_modifiers m
    join public.products p
      on p.id = m.product_id and p.business_id = m.business_id
    where m.product_id is not null and m.active
    group by m.business_id, m.product_id, m.group_label
  loop
    -- Sin duplicar si la migración se corre dos veces.
    select id into v_grupo
    from public.option_groups
    where business_id = v_fila.business_id
      and product_id = v_fila.product_id
      and name = v_fila.group_label;

    if v_grupo is null then
      insert into public.option_groups (
        business_id, product_id, name, selection_type,
        required, min_selectable, max_selectable
      ) values (
        v_fila.business_id, v_fila.product_id, v_fila.group_label, 'multiple',
        false, 0, greatest(v_fila.tope, 1)
      ) returning id into v_grupo;
    end if;

    insert into public.options (
      business_id, option_group_id, name, description, price_adjustment, sort, active
    )
    select m.business_id, v_grupo, m.name, m.description,
           coalesce(m.price_delta, 0), m.sort, m.active
    from public.menu_modifiers m
    where m.business_id = v_fila.business_id
      and m.product_id = v_fila.product_id
      and m.group_label = v_fila.group_label
      and m.active
      and not exists (
        select 1 from public.options o
        where o.option_group_id = v_grupo and o.name = m.name
      );

    v_copiados := v_copiados + 1;
  end loop;

  raise notice 'MODIFICADORES: % grupo(s) copiados desde menu_modifiers (la tabla vieja NO se toca)', v_copiados;
end $$;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
-- Se ejercita lo que de verdad importa: que las fronteras entre negocios estén
-- cerradas y que las reglas del grupo no admitan configuraciones imposibles.
do $comprobacion$
declare
  v_a uuid; v_b uuid; v_pa uuid; v_pb uuid; v_g uuid;
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('motor-a', 'A', 'pizzería', 'ycloud', '+593900444001', '+593900444001', true)
  returning id into v_a;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('motor-b', 'B', 'pizzería', 'ycloud', '+593900444002', '+593900444002', true)
  returning id into v_b;

  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Pizza de A', 10, 'disponible', true) returning id into v_pa;
  insert into products (business_id, name, price, stock, active)
  values (v_b, 'Pizza de B', 10, 'disponible', true) returning id into v_pb;

  -- FRONTERA 1: el negocio A no puede colgar un grupo del producto de B.
  begin
    insert into public.option_groups (business_id, product_id, name)
    values (v_a, v_pb, 'Tamaño');
    raise exception 'FUGA: A colgó un grupo del producto de B';
  exception when foreign_key_violation then null;
  end;

  insert into public.option_groups (
    business_id, product_id, name, selection_type, required, min_selectable, max_selectable
  ) values (v_a, v_pa, 'Tamaño', 'single', true, 1, 1) returning id into v_g;

  -- FRONTERA 2: una opción de A no puede referenciar un producto de B.
  begin
    insert into public.options (business_id, option_group_id, name, references_product_id)
    values (v_a, v_g, 'Pizza ajena', v_pb);
    raise exception 'FUGA: un combo de A incluyó un producto de B';
  exception when foreign_key_violation then null;
  end;

  -- Y el uso legítimo funciona: un combo con producto propio.
  insert into public.options (business_id, option_group_id, name, references_product_id)
  values (v_a, v_g, 'Pizza propia', v_pa);

  -- REGLA: obligatorio sin mínimo no se admite.
  begin
    insert into public.option_groups (business_id, product_id, name, required, min_selectable)
    values (v_a, v_pa, 'Roto', true, 0);
    raise exception 'Se admitió un grupo obligatorio sin mínimo';
  exception when check_violation then null;
  end;

  -- REGLA: `single` no puede permitir varias.
  begin
    insert into public.option_groups (business_id, product_id, name, selection_type, max_selectable)
    values (v_a, v_pa, 'Roto', 'single', 5);
    raise exception 'Se admitió un radio con máximo 5';
  exception when check_violation then null;
  end;

  -- Borrar el producto se lleva sus grupos, y no revienta por la opción que lo
  -- referenciaba: `set null (references_product_id)` con la columna nombrada.
  insert into public.products (business_id, name, price, stock, active)
  values (v_a, 'Desechable', 5, 'disponible', true) returning id into v_pb;
  insert into public.options (business_id, option_group_id, name, references_product_id)
  values (v_a, v_g, 'Apunta al desechable', v_pb);
  delete from public.products where id = v_pb;
  if exists (select 1 from public.options
             where option_group_id = v_g and name = 'Apunta al desechable'
               and (references_product_id is not null or business_id is null)) then
    raise exception 'Borrar el producto dejó la opción en mal estado';
  end if;

  delete from businesses where id in (v_a, v_b);
  raise notice 'MOTOR DE OPCIONES: fronteras cerradas y reglas del grupo comprobadas';
end;
$comprobacion$;
