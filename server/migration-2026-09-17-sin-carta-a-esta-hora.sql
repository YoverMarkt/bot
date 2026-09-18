-- ═══════════════════════════════════════════════════════════════════════════
-- ABIERTO, PERO SIN CARTA A ESTA HORA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo abrieron los menús con reloj (2026-09-17): una cafetería de desayunos
-- puede tener el local ABIERTO hasta las 22:00 y toda su carta en la franja
-- 07:00–11:00. A las nueve de la noche el cliente la elegía en el menú,
-- recibía su enlace, entraba… y no podía pedir nada. Peor que un local
-- cerrado, porque a ese al menos se le avisa.
--
-- El menú del chat lo trata igual que un cerrado —luna, al final de la lista y
-- el motivo en el cuerpo del mensaje—, y para eso necesita el dato de la base.
--
-- ⚠️ Solo se marca al local que TIENE catálogo y no puede servir nada ahora.
-- Uno sin productos no tiene un problema de hora, y decirle «su carta empieza
-- a las 7» sería inventarle una promesa.
--
-- ⚠️ La firma no cambia (`text`), pero SÍ las columnas que devuelve, y eso
-- `create or replace` no lo admite: hay que soltarla y volver a crearla. Los
-- permisos se vuelven a poner abajo, porque el `drop` se los lleva.

drop function if exists public.marketplace_negocios_de_categoria(text);

create function public.marketplace_negocios_de_categoria(p_code text)
returns table (
  id          uuid,
  slug        text,
  name        text,
  type        text,
  prep_min    integer,
  -- ¿Se le puede pedir algo AHORA? Falso solo si tiene carta y ninguna parte
  -- de ella está en su franja en este momento.
  con_carta   boolean,
  -- Desde qué hora vuelve a haber algo. Nulo si no se puede saber.
  carta_desde time
)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct b.id, b.slug, b.name, b.type,
         b.prep_time_minutes + coalesce(b.delivery_extra_minutes, 0),
         (
           not exists (
             select 1 from public.products p
             where p.business_id = b.id and p.active
           )
           or exists (
             select 1 from public.products p
             where p.business_id = b.id and p.active
               and public.producto_en_horario(
                 p.available_days, p.available_from, p.available_until)
           )
         ),
         (
           select min(p.available_from) from public.products p
           where p.business_id = b.id and p.active and p.available_from is not null
         )
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
