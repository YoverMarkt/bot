-- ============================================================================
-- LA BÚSQUEDA RECORTA POR RELEVANCIA, NO POR IDENTIFICADOR
--
-- `marketplace_buscar_negocios` terminaba así:
--
--     select distinct on (t.id) … from todo t
--     order by t.id, t.orden desc
--     limit N;
--
-- El `distinct on` obliga a que el `order by` EMPIECE por `t.id`, y el
-- `limit` iba pegado a esa misma consulta. Resultado: con más locales que el
-- límite se quedaban los N de uuid más bajo —un sorteo—, y el más parecido a
-- lo que escribió el cliente podía quedarse fuera. Los que salían, además,
-- llegaban al chat en ese orden sin sentido.
--
-- Hoy casi nunca hay más de 9 coincidencias, y por eso no se había visto. Con
-- cada local que se dé de alta pasa a ser lo normal.
--
-- El arreglo separa los dos pasos: primero el mejor motivo de cada local
-- (`mejor`), DESPUÉS ordenar por relevancia y recortar. El nombre desempata.
--
-- Lo vigila `tests/sql/verificar-esquema.sql` con el local más parecido
-- llevando el uuid MÁS ALTO: con el código viejo queda fuera siempre.
--
-- Sin cambios de tabla, de permisos ni de firma: solo el final de la función.
-- ============================================================================

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
  ),
  -- Un local aparece UNA vez, con su mejor motivo…
  mejor as (
    select distinct on (t.id) t.id, t.slug, t.name, t.type, t.motivo, t.orden
    from todo t
    order by t.id, t.orden desc
  )
  -- …y el recorte va por RELEVANCIA, no por identificador.
  --
  -- ⚠️ Hasta el 2026-09-26 el `limit` iba pegado al `distinct on`, cuyo
  -- `order by` EMPIEZA por `t.id` —así lo exige PostgreSQL—. Con más locales
  -- que el límite se quedaban los de uuid más bajo, que es un sorteo: el más
  -- parecido podía quedarse fuera, y los que salían llegaban en ese mismo
  -- orden sin sentido. El nombre desempata para que la lista no baile.
  select m.id, m.slug, m.name, m.type, m.motivo, m.orden
  from mejor m
  order by m.orden desc, m.name
  limit greatest(coalesce(p_limite, 8), 1);
$$;
