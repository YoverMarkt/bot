-- ═══════════════════════════════════════════════════════════════════════════
-- EL PANEL LEE LOS CAJONES DE UN LOCAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El detalle del superadmin preguntaba por los cajones leyendo la VISTA
-- `marketplace_cajones_de_negocio` con un `select` anidado de PostgREST
-- (`marketplace_categories!inner(...)`). PostgREST deduce esos anidados de las
-- FOREIGN KEYS, y una vista no tiene ninguna: la consulta falla siempre.
--
-- ⚠️ Y fallaba EN SILENCIO, que es lo grave: la ruta tenía un `catch` que
-- devolvía lista vacía, así que el panel enseñaba «sin elegir» a un local que
-- sí tenía sus cajones puestos. Se vio probando el alta real contra
-- producción, no en las pruebas — todas en verde con el repositorio simulado.
--
-- La resuelve la base, que es quien sabe la regla entera («los elegidos, o los
-- de su tipo»), y así el panel no la reimplementa.
create or replace function public.marketplace_cajones_del_negocio(p_business_id uuid)
returns table (
  code      text,
  label     text,
  emoji     text,
  principal boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.code, c.label, c.emoji, v.principal
  from public.marketplace_cajones_de_negocio v
  join public.marketplace_categories c on c.id = v.category_id
  where v.business_id = p_business_id
    and c.active
  -- El principal primero y el resto por el orden del menú: es como se leen en
  -- el panel y como se vuelven a mandar al guardar.
  order by v.principal desc, c.sort;
$$;

revoke all on function public.marketplace_cajones_del_negocio(uuid)
  from public, anon, authenticated;
grant execute on function public.marketplace_cajones_del_negocio(uuid)
  to service_role;
