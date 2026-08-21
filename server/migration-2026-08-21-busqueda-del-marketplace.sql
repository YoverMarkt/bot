-- ═══════════════════════════════════════════════════════════════════════════
-- BUSCAR SIN IA
--
-- «Quiero ceviche» tiene que encontrar locales aunque «ceviche» no esté en el
-- menú principal. Hoy la única búsqueda que existe es `match_products`, que
-- necesita un embedding —una llamada de IA de pago— y además solo mira DENTRO
-- de un negocio. Para el marketplace no sirve ninguna de las dos cosas.
--
-- Esto lo resuelve con PostgreSQL y nada más, en tres capas, parando en la
-- primera que responda:
--
--   1. ALIAS  — lo que el superadmin enseña a mano: «cebiche» → mariscos.
--   2. TEXTO  — `to_tsvector('spanish', …)`. El diccionario ya quita tildes y
--               reduce a raíz: «camarón» y «camarones» casan solos.
--   3. PARECIDO — trigramas, para el dedazo y la variante de escritura.
--
-- ⚠️ LAS TRES CAPAS HACEN FALTA, y está medido: el diccionario español reduce
-- «ceviche» a 'cevich' y «cebiche» a 'cebich', así que POR TEXTO NO CASAN. Por
-- trigrama sí (0.45, sobre el umbral de 0.3). Las dos grafías se usan en
-- Ecuador, así que sin la tercera capa media clientela no encuentra su plato.
--
-- ⚠️ Las funciones de pg_trgm se llaman CALIFICADAS con su esquema
-- (`extensions.similarity`). Supabase instala las extensiones fuera de
-- `public`, y una función que las llama sin calificar depende de que el
-- `search_path` las alcance — que es exactamente el fallo que dejó el canal
-- mudo cinco días en julio de 2026. Calificar no depende de nada.
--
-- ⚠️ La IA no entra aquí. Cuando entre (fase 12) será para TRADUCIR una frase
-- suelta a una consulta, y el resultado se validará contra estas funciones:
-- nunca inventará un local ni un producto.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm with schema extensions;
-- `unaccent` normaliza lo que ESCRIBE el cliente antes de compararlo. El
-- diccionario español ya quita tildes dentro del índice de texto, pero el
-- trigrama compara cadenas crudas: sin esto, «camaron» no encontraría
-- «camarón».
create extension if not exists unaccent with schema extensions;


-- ── 1. Lo que el superadmin enseña a mano ──────────────────────────────────
--
-- La capa más barata y la más predecible. Un término que la gente usa y que no
-- aparece escrito en ningún producto —«parrillada» para un asadero, «chifa»
-- para comida china— se resuelve aquí sin depender de cómo esté redactada la
-- carta de cada local.
create table if not exists public.marketplace_search_aliases (
  term          text primary key,
  category_code text not null
                references public.marketplace_categories(code) on delete cascade,
  created_at    timestamptz not null default now(),

  -- Se guarda ya normalizado —minúsculas, sin tildes—: normalizar al leer
  -- obligaría a recorrer la tabla entera en vez de usar la clave.
  constraint marketplace_search_aliases_term_check check (
    term = btrim(lower(term)) and char_length(term) between 2 and 40
  )
);

alter table public.marketplace_search_aliases enable row level security;

create index if not exists idx_marketplace_search_aliases_categoria
  on public.marketplace_search_aliases (category_code);

insert into public.marketplace_search_aliases (term, category_code) values
  -- Las tres grafías se usan en Ecuador. «sebiche» queda por debajo del
  -- umbral de parecido (0.29), así que sin el alias no se encuentra: es
  -- justo para lo que existe esta capa.
  ('ceviche','mariscos'), ('cebiche','mariscos'), ('sebiche','mariscos'),
  ('encebollado','mariscos'), ('corviche','mariscos'), ('bolon','desayunos'),
  ('camaron','mariscos'), ('pescado','mariscos'), ('marisco','mariscos'),
  ('pizza','pizzerias'),
  ('hamburguesa','hamburguesas'), ('burger','hamburguesas'), ('papas','hamburguesas'),
  ('almuerzo','almuerzos'), ('menu del dia','almuerzos'), ('seco','almuerzos'),
  ('pollo','asados'), ('parrillada','asados'), ('asado','asados'), ('carne','asados'),
  ('chifa','internacional'), ('sushi','internacional'), ('tacos','internacional'),
  ('desayuno','desayunos'), ('cafe','desayunos'),
  ('helado','postres'), ('torta','postres'), ('postre','postres'),
  ('jugo','jugos'), ('batido','jugos'),
  ('pan','panaderias'),
  ('supermercado','minimarkets'), ('vivares','minimarkets'), ('abarrotes','minimarkets'),
  ('medicina','farmacias'), ('farmacia','farmacias'),
  ('perfume','perfumerias')
on conflict (term) do nothing;


-- ── 2. Los índices que hacen que esto no recorra la tabla entera ───────────
--
-- ⚠️ `to_tsvector('spanish', …)` con la configuración ESCRITA es inmutable, y
-- por eso puede indexarse. `to_tsvector(x)` sin ella no lo es —depende de un
-- ajuste de sesión— y PostgreSQL rechazaría el índice.
create index if not exists idx_products_busqueda_texto
  on public.products
  using gin (to_tsvector('spanish', coalesce(name,'') || ' ' || coalesce(description,'')));

create index if not exists idx_products_busqueda_parecido
  on public.products using gin (name extensions.gin_trgm_ops);

create index if not exists idx_businesses_busqueda_parecido
  on public.businesses using gin (name extensions.gin_trgm_ops);


-- ── 2b. Sacar la intención y quedarse con lo que se pide ───────────────────
--
-- El cliente NO escribe «ceviche»: escribe «quiero ceviche», «tienen pizza»,
-- «me das un encebollado». Sin quitar esas muletillas:
--
--   · el alias no casa —la clave es «ceviche», no «quiero ceviche»—;
--   · y `plainto_tsquery` exige TODAS las palabras, así que busca productos
--     que digan «quiero» Y «ceviche», y no existe ninguno.
--
-- Medido antes de escribir esto: «quiero ceviche» encontraba UN local de tres,
-- y por parecido de cadena, que es pura suerte.
--
-- ⚠️ `immutable`: hace falta para poder usarla dentro de la consulta sin que
-- PostgreSQL la reevalúe por fila.
create or replace function public.marketplace_normalizar_consulta(p_texto text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  -- Palabra por palabra, no con una regex sobre la frase.
  --
  -- ⚠️ Una regex del tipo `\s(muletilla)\s` CONSUME el espacio que separa, así
  -- que no puede casar dos muletillas seguidas: «quisiera un cebiche» dejaba
  -- «un cebiche». Filtrando la lista de palabras no existe ese problema, y
  -- además se lee.
  select btrim(array_to_string(array(
    select palabra
    from unnest(string_to_array(
      regexp_replace(
        btrim(lower(extensions.unaccent(coalesce(p_texto, '')))),
        -- Fuera la puntuación: «pizza?» no casa con el alias «pizza», y ese
        -- signo lo escribe casi todo el mundo.
        '[^a-z0-9 ]', ' ', 'g'
      ), ' '
    )) as palabra
    where palabra <> ''
      and palabra not in (
        -- Cómo pide la gente, no qué pide.
        'quiero','quisiera','queria','busco','buscar','necesito','deseo',
        'dame','damelo','das','dan','da','traes','traeme','trae','mandame',
        'manda','mandas','envias','envia','tienes','tienen','tiene','hay',
        'vendes','venden','venta','gustaria','antojo','antoja','pedir',
        'ordenar','comer','ver','favor','porfa','porfavor',
        'hola','buenas','buenos','dias','tardes','noches','gracias',
        'me','se','te','le','yo','mi',
        'un','una','unos','unas','el','la','los','las','lo',
        'de','del','para','con','sin','por','en','y','o','algo','que'
      )
  ), ' '));
$$;

-- ── 3. Buscar locales en todo el marketplace ───────────────────────────────
--
-- Devuelve LOCALES, no productos: antes de elegir negocio, lo que el cliente
-- necesita es saber a quién pedirle. Y `motivo` viaja con cada uno para que el
-- mensaje pueda decir por qué salió.
--
-- ⚠️ Los mismos requisitos de disponibilidad que el menú. Encontrar un local
-- que no puede recibir el pedido es peor que no encontrar ninguno: el cliente
-- ya eligió.
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
    select d.id, d.slug, d.name, d.type, 'categoria'::text as motivo, 3.0::real as orden
    from consulta c
    -- ⚠️ Palabra por palabra, además de la frase entera. La lista de
    -- muletillas nunca va a estar completa —el cliente escribe lo que quiere—,
    -- y sin esto una sola que se cuele deja la capa más barata sin casar.
    -- Con esto, «me das un encebollado» encuentra el alias «encebollado»
    -- aunque «das» sobreviva a la limpieza.
    join public.marketplace_search_aliases a
      on a.term = c.texto
      or a.term = any(string_to_array(c.texto, ' '))
    join public.marketplace_category_types t on t.category_id = (
      select mc.id from public.marketplace_categories mc where mc.code = a.category_code
    )
    join disponibles d on d.type = t.business_type
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


-- ── 4. Buscar DENTRO del local elegido ─────────────────────────────────────
--
-- «También quiero Coca Cola» cuando ya está en El Puerto. ⚠️ El filtro por
-- `business_id` no es una comodidad: sin él, la Coca Cola de otro local
-- entraría en un carrito que solo puede tener productos de uno.
create or replace function public.marketplace_buscar_productos(
  p_business_id uuid,
  p_query       text,
  p_limite      integer default 8
)
returns table (
  id     uuid,
  name   text,
  price  numeric,
  orden  real
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  with consulta as (
    select public.marketplace_normalizar_consulta(p_query) as texto
  )
  select distinct on (p.id) p.id, p.name, p.price,
         greatest(
           ts_rank(
             to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,'')),
             plainto_tsquery('spanish', c.texto)
           ) + 1.0,
           extensions.similarity(lower(p.name), c.texto)
         )::real as orden
  from consulta c
  join public.products p
    on p.business_id = p_business_id
   and p.active
   and (
     to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,''))
       @@ plainto_tsquery('spanish', c.texto)
     or extensions.similarity(lower(p.name), c.texto) > 0.3
   )
  where c.texto <> ''
  order by p.id, orden desc
  limit greatest(coalesce(p_limite, 8), 1);
$$;

revoke all on function public.marketplace_buscar_productos(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.marketplace_buscar_productos(uuid, text, integer)
  to service_role;

revoke all on function public.marketplace_normalizar_consulta(text)
  from public, anon, authenticated;
grant execute on function public.marketplace_normalizar_consulta(text)
  to service_role;
