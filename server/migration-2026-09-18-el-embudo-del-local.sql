-- ═══════════════════════════════════════════════════════════════════════════
-- EL EMBUDO DEL LOCAL: CÓMO LLEGAN SUS CLIENTES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pedido del dueño (2026-09-18): «el módulo de reportes para los dueños tendría
-- que enfocarse a este nuevo modelo que es Umbani, porque donde van a escribir
-- ahora es el número de Umbani».
--
-- ⚠️ Tenía razón, y con números: cuatro de sus reportes se alimentan de tablas
-- MUERTAS desde que se retiró el bot por chat —`product_consultations` (2
-- filas, la última del 2026-08-03), `ai_gaps` (0 filas) y `conversation_history`
-- (parada el 2026-08-23)—. El dueño abría su panel y veía cuatro tarjetas
-- vacías para siempre. Mientras tanto, lo que SÍ pasa no se enseñaba en
-- ninguna parte: 62 enlaces emitidos en 30 días y 30 abiertos.
--
-- Estas dos funciones cuentan lo que de verdad ocurre hoy, por local.

-- ── 1. El camino de su cliente ─────────────────────────────────────────────
--
-- Del enlace al pedido entregado. Se cuentan PERSONAS distintas, no enlaces:
-- quien pide tres veces es un cliente, no tres.
create or replace function public.local_embudo(
  p_business_id uuid,
  p_dias        integer default 30
)
returns table (
  paso     text,
  orden    integer,
  clientes bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with desde as (select now() - make_interval(days => greatest(coalesce(p_dias, 30), 1)) as d),
  enlaces as (
    select s.customer_id, s.last_seen_at
    from public.storefront_sessions s, desde
    where s.business_id = p_business_id and s.created_at >= desde.d
      and s.customer_id is not null
  ),
  pedidos as (
    select o.customer_id, o.status
    from public.orders o, desde
    where o.business_id = p_business_id and o.created_at >= desde.d
      and o.customer_id is not null
  )
  select 'recibieron su enlace'::text, 1, count(distinct customer_id) from enlaces
  union all
  select 'abrieron su tienda', 2, count(distinct customer_id)
    from enlaces where last_seen_at is not null
  union all
  select 'hicieron un pedido', 3, count(distinct customer_id) from pedidos
  union all
  select 'recibieron su pedido', 4, count(distinct customer_id)
    from pedidos where status in ('completado', 'entregado')
  order by 2;
$$;

revoke all on function public.local_embudo(uuid, integer) from public, anon, authenticated;
grant execute on function public.local_embudo(uuid, integer) to service_role;


-- ── 2. Por dónde lo encontraron ────────────────────────────────────────────
--
-- De qué cajón del menú de Umbani salió cada cliente que eligió este local.
-- Es lo que le dice al dueño si le llegan buscando «almuerzo» o buscando
-- «cena», y por tanto qué carta le conviene tener lista a cada hora.
create or replace function public.local_llegadas(
  p_business_id uuid,
  p_dias        integer default 30
)
returns table (
  code   text,
  label  text,
  veces  bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(c.code, 'busqueda'), coalesce(c.label, 'Escribiendo lo que querían'),
         count(*)::bigint
  from public.marketplace_events e
  left join public.marketplace_categories c on c.code = e.category_code
  where e.tipo = 'local'
    and e.business_id = p_business_id
    and e.created_at >= now() - make_interval(days => greatest(coalesce(p_dias, 30), 1))
  group by coalesce(c.code, 'busqueda'), coalesce(c.label, 'Escribiendo lo que querían')
  order by count(*) desc;
$$;

revoke all on function public.local_llegadas(uuid, integer) from public, anon, authenticated;
grant execute on function public.local_llegadas(uuid, integer) to service_role;
