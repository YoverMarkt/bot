-- ═══════════════════════════════════════════════════════════════════════════
-- UN LOCAL VIVE EN VARIOS CAJONES DEL MENÚ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El menú del chat ofrece CAJONES —«🍕 Pizzerías», «🍽️ Almuerzos»— y hasta hoy
-- el cajón de un local salía de su TIPO, que es uno solo. Un local de comida
-- típica que sirve almuerzo al mediodía y carta de noche vivía únicamente bajo
-- «Almuerzos», y el dueño lo dijo con el caso exacto: «son las 7 de la noche,
-- el cliente ve solo Almuerzos y piensa que no hay nada para él».
--
-- ⚠️ EL CAJÓN NO ES UNA CLASIFICACIÓN DE EMPRESAS, ES UN ANTOJO. Así lo tratan
-- las apps grandes: el cliente no busca «un restaurante de comida típica»,
-- busca pizza, pollo, almuerzo o desayuno. Y un local real cubre VARIOS
-- antojos, así que se cuelga de varios cajones —uno principal y hasta dos más—
-- en vez de elegir el menos malo.
--
-- Lo que trae esta migración:
--   1. El cajón «🍲 Comida típica y restaurantes», que faltaba: «Almuerzos» se
--      queda para el menú del día, que en Ecuador es un producto, no una hora.
--   2. `business_marketplace_categories`: los cajones ELEGIDOS de cada local.
--   3. El tipo sigue mandando para quien no eligió ninguno, así que ningún
--      local existente cambia de sitio ni hay que tocar nada a mano.
--   4. Las tres funciones del menú leen los cajones en vez del tipo.
--
-- Lo que NO toca: el tipo de negocio (sigue decidiendo la carta de arranque,
-- el tiempo de preparación y el vocabulario del panel), los pedidos, la tienda
-- ni el dinero.


-- ── 1. El cajón que faltaba ────────────────────────────────────────────────
--
-- ⚠️ `sort` 35: entre Almuerzos (30) y Asados (40). El orden del menú es el de
-- lo que más se pide, y una carta de restaurante se pide menos que un almuerzo.
insert into public.marketplace_categories (code, label, emoji, sort, active)
values ('restaurantes', 'Comida típica y restaurantes', '🍲', 35, true)
on conflict (code) do nothing;

-- Los dos tipos que de verdad son «carta», no «menú del día», se mudan aquí.
-- ⚠️ Solo cambia de dónde CUELGA el tipo. Un local que ya existiera conserva su
-- sitio, porque el paso 5 le siembra sus cajones actuales antes de que nadie
-- lea esta tabla.
update public.marketplace_category_types
   set category_id = (select id from public.marketplace_categories where code = 'restaurantes')
 where business_type in ('comida típica', 'restaurante');

-- Palabras con las que se busca de noche. Una sola palabra por término: la
-- búsqueda parte la consulta en palabras de 3 letras o más.
insert into public.marketplace_search_aliases (term, category_code) values
  ('restaurante', 'restaurantes'),
  ('restaurantes', 'restaurantes'),
  ('cena', 'restaurantes'),
  ('cenar', 'restaurantes'),
  ('merienda', 'restaurantes'),
  ('tipica', 'restaurantes'),
  ('criolla', 'restaurantes')
on conflict (term) do nothing;


-- ── 2. Los cajones elegidos de cada local ──────────────────────────────────
create table if not exists public.business_marketplace_categories (
  business_id uuid not null references public.businesses(id) on delete cascade,
  category_id uuid not null references public.marketplace_categories(id) on delete cascade,
  -- El cajón donde el local «vive». Hoy solo ordena la lectura del panel; se
  -- guarda desde el principio porque saber cuál es el principal es lo que
  -- permitirá más adelante ordenar por relevancia sin volver a preguntar.
  principal   boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (business_id, category_id)
);

comment on table public.business_marketplace_categories is
  'En qué cajones del menú del chat aparece un local. Sin filas manda su tipo.';

-- Un solo principal por local.
create unique index if not exists uq_business_marketplace_categories_principal
  on public.business_marketplace_categories (business_id) where principal;

create index if not exists idx_business_marketplace_categories_categoria
  on public.business_marketplace_categories (category_id);

alter table public.business_marketplace_categories enable row level security;
revoke all on table public.business_marketplace_categories from public, anon, authenticated;
grant select, insert, update, delete
  on table public.business_marketplace_categories to service_role;


-- ── 3. Tres cajones como mucho ─────────────────────────────────────────────
--
-- ⚠️ Lo vigila la BASE y no solo la ruta: un local en ocho cajones convierte el
-- menú en ruido y el cliente deja de fiarse de los botones. El tope es de
-- producto, no técnico, pero si vive solo en el panel se salta desde cualquier
-- otro camino que escriba esta tabla.
create or replace function public.business_marketplace_categories_tope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (
    select count(*) from public.business_marketplace_categories
    where business_id = new.business_id
  ) > 3 then
    raise exception 'Un local aparece en 3 cajones del menú como mucho'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists business_marketplace_categories_tope
  on public.business_marketplace_categories;
create trigger business_marketplace_categories_tope
  after insert on public.business_marketplace_categories
  for each row execute function public.business_marketplace_categories_tope();


-- ── 4. Dónde vive cada local, en UN solo sitio ─────────────────────────────
--
-- Resuelve la regla completa: manda lo elegido, y quien no eligió nada sigue
-- saliendo por su tipo. Es una vista y no tres copias del mismo `union` porque
-- las tres funciones del menú tienen que contestar SIEMPRE lo mismo; tres
-- copias acaban divergiendo y el local aparece en la lista pero no en el
-- contador, o al revés.
--
-- `security_invoker`: la llama `service_role`, que ya lee las dos tablas.
create or replace view public.marketplace_cajones_de_negocio
with (security_invoker = true) as
  select bc.business_id, bc.category_id, bc.principal
    from public.business_marketplace_categories bc
  union all
  select b.id, t.category_id, true
    from public.businesses b
    join public.marketplace_category_types t on t.business_type = b.type
   where not exists (
     select 1 from public.business_marketplace_categories x where x.business_id = b.id
   );

comment on view public.marketplace_cajones_de_negocio is
  'Cajones de cada local: los elegidos, o los de su tipo si no eligió ninguno.';

revoke all on public.marketplace_cajones_de_negocio from public, anon, authenticated;
grant select on public.marketplace_cajones_de_negocio to service_role;


-- ── 5. Los locales de hoy conservan su sitio ───────────────────────────────
--
-- Se siembra DESPUÉS de mudar los tipos, así que lo que queda escrito es el
-- cajón que cada local tiene en este momento. A partir de aquí, mover un tipo
-- no mueve a nadie que ya exista: eso lo decide su dueño.
insert into public.business_marketplace_categories (business_id, category_id, principal)
select b.id, t.category_id, true
  from public.businesses b
  join public.marketplace_category_types t on t.business_type = b.type
 where not exists (
   select 1 from public.business_marketplace_categories x where x.business_id = b.id
 )
on conflict do nothing;


-- ── 6. Las tres funciones del menú leen los cajones ────────────────────────

create or replace function public.marketplace_categories_disponibles()
returns table (
  code    text,
  label   text,
  emoji   text,
  sort    integer,
  locales bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.code, c.label, c.emoji, c.sort, count(distinct b.id) as locales
  from public.marketplace_categories c
  join public.marketplace_cajones_de_negocio v on v.category_id = c.id
  join public.businesses b on b.id = v.business_id
  where c.active
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  group by c.code, c.label, c.emoji, c.sort
  having count(distinct b.id) > 0
  order by c.sort, c.label;
$$;

revoke all on function public.marketplace_categories_disponibles()
  from public, anon, authenticated;
grant execute on function public.marketplace_categories_disponibles()
  to service_role;


create or replace function public.marketplace_negocios_de_categoria(p_code text)
returns table (
  id       uuid,
  slug     text,
  name     text,
  type     text,
  prep_min integer
)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct b.id, b.slug, b.name, b.type,
         b.prep_time_minutes + coalesce(b.delivery_extra_minutes, 0)
  from public.businesses b
  join public.marketplace_cajones_de_negocio v on v.business_id = b.id
  join public.marketplace_categories c on c.id = v.category_id
  where c.code = p_code
    and c.active
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  order by b.name;
$$;

revoke all on function public.marketplace_negocios_de_categoria(text)
  from public, anon, authenticated;
grant execute on function public.marketplace_negocios_de_categoria(text)
  to service_role;


-- La búsqueda: su capa de alias también sale de los cajones, o «cena» seguiría
-- encontrando locales por su tipo y no por donde de verdad están. El resto de
-- la función —las capas de producto, parecido y nombre— queda intacto.
create or replace function public.marketplace_buscar_negocios(
  p_query text,
  p_limite integer default 8
)
returns table (
  id     uuid,
  slug   text,
  name   text,
  type   text,
  motivo text,
  orden  real
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  with consulta as (
    select public.marketplace_normalizar_consulta(p_query) as texto
  ),
  disponibles as (
    select b.* from public.businesses b
    where b.active and b.suspended is not true
      and b.takes_orders and b.storefront_enabled
  ),
  -- Capa 1: el alias manda, y por eso puntúa más alto que todo lo demás.
  por_alias as (
    select distinct d.id, d.slug, d.name, d.type, 'categoria'::text as motivo, 3.0::real as orden
    from consulta c
    -- ⚠️ Palabra por palabra, además de la frase entera. La lista de
    -- muletillas nunca va a estar completa —el cliente escribe lo que quiere—,
    -- y sin esto una sola que se cuele deja la capa más barata sin casar.
    -- Con esto, «me das un encebollado» encuentra el alias «encebollado»
    -- aunque «das» sobreviva a la limpieza.
    join public.marketplace_search_aliases a
      on a.term = c.texto
      or a.term = any(string_to_array(c.texto, ' '))
    -- ⚠️ Por CAJÓN, no por tipo (2026-09-17): un local que eligió sus cajones
    -- tiene que salir por ellos, y solo por ellos. Buscar «cena» debe traer al
    -- que se puso en «Comida típica y restaurantes», no al que comparte tipo.
    join public.marketplace_categories mc on mc.code = a.category_code
    join public.marketplace_cajones_de_negocio v on v.category_id = mc.id
    join disponibles d on d.id = v.business_id
  ),
  -- Capa 2: la carta del local menciona lo que pidió.
  por_texto as (
    select distinct on (d.id)
           d.id, d.slug, d.name, d.type, 'producto'::text as motivo,
           (2.0 + ts_rank(
              to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,'')),
              plainto_tsquery('spanish', c.texto)
           ))::real as orden
    from consulta c
    join public.products p
      on p.active
     and to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,''))
         @@ plainto_tsquery('spanish', c.texto)
    join disponibles d on d.id = p.business_id
    where c.texto <> ''
    order by d.id, orden desc
  ),
  -- Capa 3: se parece. Cubre «cebiche» contra «ceviche» y el dedazo.
  --
  -- ⚠️ Compara PALABRA POR PALABRA, no la frase entera, y está medido:
  -- «cebiche» contra «ceviche de camarones» da 0.217 mirando el nombre
  -- completo —por debajo del umbral de 0.3, así que ese local NO salía— y
  -- 0.455 mirando su mejor palabra. Las dos grafías se usan en Ecuador.
  --
  -- ⚠️ Coste conocido: así no se usa el índice de trigramas sobre `name`, que
  -- solo sirve para el nombre completo. Con el catálogo de hoy es
  -- intrascendente; el día que haya decenas de miles de productos, la salida
  -- es un índice sobre las palabras, no volver a comparar la frase entera.
  por_parecido as (
    select distinct on (d.id)
           d.id, d.slug, d.name, d.type, 'parecido'::text as motivo,
           s.parecido::real as orden
    from consulta c
    join public.products p on p.active
    cross join lateral (
      select max(extensions.similarity(palabra, c.texto)) as parecido
      from unnest(string_to_array(lower(p.name), ' ')) as palabra
    ) s
    join disponibles d on d.id = p.business_id
    where c.texto <> '' and s.parecido > 0.3
    order by d.id, orden desc
  ),
  -- Y el nombre del propio local: «Don Pepe» debe encontrar a Don Pepe.
  por_nombre as (
    select d.id, d.slug, d.name, d.type, 'local'::text as motivo,
           (1.0 + extensions.similarity(lower(d.name), c.texto))::real as orden
    from consulta c
    join disponibles d
      on extensions.similarity(lower(d.name), c.texto) > 0.3
    where c.texto <> ''
  ),
  todo as (
    select * from por_alias
    union all select * from por_texto
    union all select * from por_parecido
    union all select * from por_nombre
  )
  -- Un local aparece UNA vez, con su mejor motivo.
  select distinct on (t.id) t.id, t.slug, t.name, t.type, t.motivo, t.orden
  from todo t
  order by t.id, t.orden desc
  limit greatest(coalesce(p_limite, 8), 1);
$$;

revoke all on function public.marketplace_buscar_negocios(text, integer)
  from public, anon, authenticated;
grant execute on function public.marketplace_buscar_negocios(text, integer)
  to service_role;

-- ── Guardar los cajones de un local, de una vez ────────────────────────────
--
-- Borrar e insertar en la MISMA transacción: si se hiciera en dos viajes y
-- fallara el segundo, el local se quedaría sin cajones y volvería a salir por
-- su tipo sin que nadie lo pidiera.
--
-- Una lista vacía es una decisión válida: «que mande su tipo otra vez».
create or replace function public.set_business_marketplace_categories(
  p_business_id uuid,
  p_codes       text[],
  p_principal   text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_codes     text[];
  v_principal text;
  v_puestos   integer;
begin
  if p_business_id is null then
    raise exception 'Falta el negocio' using errcode = '22023';
  end if;
  if not exists (select 1 from businesses where id = p_business_id) then
    raise exception 'El negocio no existe' using errcode = '42501';
  end if;

  v_codes := coalesce(
    array(select distinct btrim(x) from unnest(coalesce(p_codes, '{}'::text[])) x
          where btrim(x) <> ''),
    '{}'::text[]
  );

  if coalesce(array_length(v_codes, 1), 0) > 3 then
    raise exception 'Un local aparece en 3 cajones del menú como mucho'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from unnest(v_codes) c
    where not exists (
      select 1 from marketplace_categories mc where mc.code = c and mc.active
    )
  ) then
    raise exception 'Ese cajón del menú no existe' using errcode = '22023';
  end if;

  -- Sin principal explícito manda el primero de la lista: el panel los manda
  -- en el orden en que el superadmin los eligió.
  v_principal := coalesce(nullif(btrim(coalesce(p_principal, '')), ''), v_codes[1]);
  if v_principal is not null and not (v_principal = any(v_codes)) then
    raise exception 'El cajón principal tiene que ser uno de los elegidos'
      using errcode = '22023';
  end if;

  delete from business_marketplace_categories where business_id = p_business_id;
  insert into business_marketplace_categories (business_id, category_id, principal)
  select p_business_id, mc.id, mc.code = v_principal
    from marketplace_categories mc
   where mc.code = any(v_codes);
  get diagnostics v_puestos = row_count;
  return v_puestos;
end;
$$;

revoke all on function public.set_business_marketplace_categories(uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.set_business_marketplace_categories(uuid, text[], text)
  to service_role;
