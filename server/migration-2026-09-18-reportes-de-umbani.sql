-- ═══════════════════════════════════════════════════════════════════════════
-- LAS TRES PREGUNTAS DEL DUEÑO SOBRE EL MENÚ DE UMBANI
-- ═══════════════════════════════════════════════════════════════════════════
--
-- «Qué cajones se tocan, cuáles se abandonan y qué escribe la gente». Se
-- responden sobre `marketplace_events` (2026-09-18), y llegan AHORA porque
-- llegan con la pantalla que las enseña: el guardián de funciones huérfanas
-- paró —con razón— que nacieran en la base sin nadie que las llamara.
--
-- ⚠️ Todo se cuenta en CLIENTES DISTINTOS, no en eventos: quien toca cinco
-- cajones es una persona buscando, no cinco personas.

-- ── 1. El embudo ───────────────────────────────────────────────────────────
--
-- Los cuatro pasos del menú más los dos que ya vivían en otras tablas: abrir
-- la tienda (`storefront_sessions.last_seen_at`) y pedir (`orders`). Es la
-- foto de dónde se cae la gente.
create or replace function public.marketplace_embudo(p_dias integer default 7)
returns table (
  paso     text,
  orden    integer,
  clientes bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with desde as (select now() - make_interval(days => greatest(coalesce(p_dias, 7), 1)) as d),
  eventos as (
    select e.tipo, e.customer_id from public.marketplace_events e, desde
    where e.created_at >= desde.d and e.customer_id is not null
  )
  select 'escribieron'::text, 1, count(distinct customer_id) from eventos
  union all
  select 'vieron el menú', 2, count(distinct customer_id) from eventos where tipo = 'menu'
  union all
  select 'entraron a un cajón', 3, count(distinct customer_id) from eventos where tipo = 'cajon'
  union all
  select 'eligieron un local', 4, count(distinct customer_id) from eventos where tipo = 'local'
  union all
  select 'abrieron su tienda', 5, count(distinct s.customer_id)
    from public.storefront_sessions s, desde
    where s.created_at >= desde.d and s.last_seen_at is not null
  union all
  select 'pidieron', 6, count(distinct o.customer_id)
    from public.orders o, desde
    where o.created_at >= desde.d
  order by 2;
$$;

revoke all on function public.marketplace_embudo(integer) from public, anon, authenticated;
grant execute on function public.marketplace_embudo(integer) to service_role;


-- ── 2. Qué cajón se toca, y cuál se abandona ───────────────────────────────
--
-- «Abandonado» es el dato que pidió el dueño para afinar los NOMBRES: gente
-- que entró al cajón y no eligió ningún local en la media hora siguiente. Un
-- cajón muy tocado y muy abandonado suele ser un nombre que promete otra cosa
-- de la que hay dentro.
create or replace function public.marketplace_cajones_tocados(p_dias integer default 7)
returns table (
  code        text,
  label       text,
  entradas    bigint,
  eligieron   bigint,
  abandonaron bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with desde as (select now() - make_interval(days => greatest(coalesce(p_dias, 7), 1)) as d),
  entradas as (
    select e.id, e.customer_id, e.category_code, e.created_at
    from public.marketplace_events e, desde
    where e.tipo = 'cajon' and e.category_code is not null and e.created_at >= desde.d
  ),
  con_eleccion as (
    select en.*, exists (
      select 1 from public.marketplace_events l
      where l.tipo = 'local'
        and l.customer_id is not distinct from en.customer_id
        and l.created_at between en.created_at and en.created_at + interval '30 minutes'
    ) as eligio
    from entradas en
  )
  select c.code, c.label,
         count(*)::bigint,
         count(*) filter (where ce.eligio)::bigint,
         count(*) filter (where not ce.eligio)::bigint
  from con_eleccion ce
  join public.marketplace_categories c on c.code = ce.category_code
  group by c.code, c.label, c.sort
  order by count(*) desc, c.sort;
$$;

revoke all on function public.marketplace_cajones_tocados(integer) from public, anon, authenticated;
grant execute on function public.marketplace_cajones_tocados(integer) to service_role;


-- ── 3. Qué escribe la gente ────────────────────────────────────────────────
--
-- ⚠️ Lo que de verdad vale son las búsquedas SIN resultado, y están partidas en
-- dos cosas muy distintas:
--   · con `entendido`  → «te entiendo y NO lo tengo»: es demanda de un tipo de
--     local que falta por dar de alta (el dueño escribió «sushi de cangrejo» y
--     el menú supo que era comida internacional).
--   · sin `entendido`  → el menú no supo ni de qué hablaba: ahí se gana con un
--     alias nuevo o con un nombre de cajón mejor.
create or replace function public.marketplace_busquedas(p_dias integer default 7)
returns table (
  consulta  text,
  veces     bigint,
  sin_nada  bigint,
  entendido text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select e.consulta,
         count(*)::bigint,
         count(*) filter (where coalesce(e.resultados, 0) = 0)::bigint,
         max(c.label)
  from public.marketplace_events e
  left join public.marketplace_categories c on c.code = e.category_code
  where e.tipo = 'busqueda'
    and coalesce(btrim(e.consulta), '') <> ''
    and e.created_at >= now() - make_interval(days => greatest(coalesce(p_dias, 7), 1))
  group by e.consulta
  order by count(*) filter (where coalesce(e.resultados, 0) = 0) desc, count(*) desc
  limit 50;
$$;

revoke all on function public.marketplace_busquedas(integer) from public, anon, authenticated;
grant execute on function public.marketplace_busquedas(integer) to service_role;
