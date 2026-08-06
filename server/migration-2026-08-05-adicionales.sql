-- ============================================================================
-- «AGREGA ALGO MÁS»: LOS ADICIONALES INDEPENDIENTES
--
-- La diferencia que hay que tener clara, porque es la que decide el modelo:
--
--   COMPLEMENTO INCLUIDO   la bebida de un combo. Forma parte del producto y
--                          vive en `order_item_options`, dentro de su línea.
--   ADICIONAL INDEPENDIENTE  el pan de ajo que se suma al final. Es OTRO
--                          producto y va como su propia línea del carrito.
--
-- Sin la segunda, «agregar una bebida más» acabaría dentro de la pizza: el
-- dueño vería «Pizza (con Coca Cola)» en vez de dos cosas que preparar, y el
-- reporte de ventas contaría una unidad donde hay dos.
--
-- Esta tabla solo dice QUÉ ofrecer y DÓNDE. Lo que se pide sigue siendo un
-- producto normal, con su precio y su línea propia: no hay nada especial que
-- calcular, y por eso no toca el motor de precios.
--
-- ── De qué cuelga una recomendación ─────────────────────────────────────────
--   de un producto  → «con esta hamburguesa, ¿unas papas?»
--   de una categoría → todas las pizzas ofrecen bebidas
--   de nada          → recomendaciones del negocio, para el carrito
--
-- Es 0 o 1, no exactamente 1: las globales son un caso legítimo, al revés que
-- en `option_groups`, donde un grupo sin destino no le aparece a nadie.
--
-- Idempotente. Aditiva. Sin pérdida de datos.
-- ============================================================================

-- Las tres foráneas necesitan que existan los únicos (id, business_id) de sus
-- destinos. En `schema.sql` este bloque va ANTES de donde se crean, así que se
-- aseguran aquí: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_products_id_business
  on public.products (id, business_id);
create unique index if not exists uq_product_categories_id_business
  on public.product_categories (id, business_id);

create table if not exists public.product_recommendations (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  -- De dónde sale la sugerencia. Ambos nulos = de todo el negocio.
  source_product_id      uuid,
  source_category_id     uuid,
  -- Qué se ofrece. Es un producto de verdad del catálogo.
  recommended_product_id uuid not null,
  -- El título de la sección: «Agrega bebidas», «También te puede gustar».
  section                text not null default 'Agrega algo más',
  sort                   integer not null default 0,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint product_recommendations_datos_check check (
    char_length(btrim(section)) between 1 and 60
    and sort between 0 and 999
    and num_nonnulls(source_product_id, source_category_id) <= 1
  )
);

-- Las tres foráneas van por PAREJA (id, business_id). Sin el negocio dentro,
-- una recomendación podría ofrecer el producto de OTRO local — y ese sí que
-- acabaría en el carrito, porque un adicional es una línea de verdad.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_producto_origen'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_producto_origen
      foreign key (source_product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_categoria_origen'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_categoria_origen
      foreign key (source_category_id, business_id)
      references public.product_categories (id, business_id) on delete cascade;
  end if;

  -- Si el producto ofrecido desaparece, la recomendación se va con él: dejarla
  -- viva ofrecería algo que ya no se puede pedir.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_producto_ofrecido'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_producto_ofrecido
      foreign key (recommended_product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_recomendaciones_origen
  on public.product_recommendations (business_id, source_product_id, sort);
create index if not exists idx_recomendaciones_categoria
  on public.product_recommendations (business_id, source_category_id, sort);

-- Ofrecer dos veces lo mismo en el mismo sitio es un descuido, no una
-- intención: el cliente vería el pan de ajo repetido.
create unique index if not exists uq_recomendaciones_sin_repetir
  on public.product_recommendations (
    business_id,
    coalesce(source_product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(source_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
    recommended_product_id
  );

alter table public.product_recommendations enable row level security;
revoke all on table public.product_recommendations from public, anon, authenticated;
grant select, insert, update, delete on table public.product_recommendations to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
do $comprobacion$
declare
  v_a uuid; v_b uuid; v_pa uuid; v_pb uuid; v_ca uuid; v_pan uuid;
begin
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('reco-a', 'A', 'pizzería', 'ycloud', '+593900666101', '+593900666101', true)
  returning id into v_a;
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values ('reco-b', 'B', 'pizzería', 'ycloud', '+593900666102', '+593900666102', true)
  returning id into v_b;

  insert into product_categories (business_id, name) values (v_a, 'Pizzas')
  returning id into v_ca;
  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Pizza de A', 10, 'disponible', true) returning id into v_pa;
  insert into products (business_id, name, price, stock, active)
  values (v_a, 'Pan de ajo', 3, 'disponible', true) returning id into v_pan;
  insert into products (business_id, name, price, stock, active)
  values (v_b, 'Pizza de B', 10, 'disponible', true) returning id into v_pb;

  -- FRONTERA 1: A no puede recomendar desde el producto de B.
  begin
    insert into product_recommendations (business_id, source_product_id, recommended_product_id)
    values (v_a, v_pb, v_pan);
    raise exception 'FUGA: A colgó una recomendación del producto de B';
  exception when foreign_key_violation then null;
  end;

  -- FRONTERA 2: ni ofrecer el producto de B. Esta es la peligrosa: un
  -- adicional acaba en el carrito como línea de verdad.
  begin
    insert into product_recommendations (business_id, source_product_id, recommended_product_id)
    values (v_a, v_pa, v_pb);
    raise exception 'FUGA: A ofreció el producto de B como adicional';
  exception when foreign_key_violation then null;
  end;

  -- REGLA: de un producto O de una categoría, no de los dos.
  begin
    insert into product_recommendations (
      business_id, source_product_id, source_category_id, recommended_product_id
    ) values (v_a, v_pa, v_ca, v_pan);
    raise exception 'Se admitió una recomendación colgada de producto Y categoría';
  exception when check_violation then null;
  end;

  -- Los tres usos legítimos: por producto, por categoría y global.
  insert into product_recommendations (business_id, source_product_id, recommended_product_id, section)
  values (v_a, v_pa, v_pan, 'Agrega algo más');
  insert into product_recommendations (business_id, source_category_id, recommended_product_id, section)
  values (v_a, v_ca, v_pan, 'Con tu pizza');
  insert into product_recommendations (business_id, recommended_product_id, section)
  values (v_a, v_pan, 'También te puede gustar');

  -- Y no se puede ofrecer dos veces lo mismo en el mismo sitio.
  begin
    insert into product_recommendations (business_id, source_product_id, recommended_product_id)
    values (v_a, v_pa, v_pan);
    raise exception 'Se admitió la misma recomendación dos veces';
  exception when unique_violation then null;
  end;

  -- Si el producto ofrecido desaparece, la recomendación se va con él.
  delete from products where id = v_pan;
  if exists (select 1 from product_recommendations where business_id = v_a) then
    raise exception 'Borrar el producto dejó recomendaciones que ya no se pueden pedir';
  end if;

  delete from businesses where id in (v_a, v_b);
  raise notice 'ADICIONALES: fronteras cerradas, destino único y sin repetir';
end;
$comprobacion$;
