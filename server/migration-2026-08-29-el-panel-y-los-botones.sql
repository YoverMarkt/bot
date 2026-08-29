-- ═══════════════════════════════════════════════════════════════════════════
-- EL PANEL Y LOS DOS BOTONES USAN LA MISMA REGLA QUE TODO LO DEMÁS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo preguntó el dueño el 2026-08-29 mirando su pantalla de Clientes: «¿ese
-- tiempo va con el de bloqueado aquí en el panel, o tengo que quitarlo yo?».
-- La respuesta era que ninguna de las dos, y al comprobarlo salieron tres
-- fallos — dos de ellos con el botón que MÁS importa.
--
-- ── 1. El panel mentía sobre el plazo ──────────────────────────────────────
--
-- `getBlockedPhones` listaba `blocked_at is not null` y nada más. El bloqueo
-- temporal TAMBIÉN pone `blocked_at`, así que a los 30 minutos el cliente ya
-- podía pedir —la base y el chat lo dejaban— y el panel seguía diciendo
-- «Bloqueado» para siempre. Información falsa sobre la que el dueño decide.
--
-- ── 2. «Bloquear» NO bloqueaba a quien tuvo un temporal antes ──────────────
--
-- El peor de los tres. `setContactBlocked(true)` ponía `blocked_at` y dejaba
-- el `blocked_until` viejo. Y la regla dice que un bloqueo es permanente
-- cuando `blocked_at` está puesto **y `blocked_until` es nulo**:
--
--     blocked_at puesto ✓ · blocked_until nulo ✗  → no permanente
--     blocked_until > now() ✗                     → no temporal
--     ⇒ NO BLOQUEADO
--
-- El dueño pulsaba «Bloquear», el panel le decía «Cliente bloqueado», y esa
-- persona seguía pudiendo pedir. Le pasaba a cualquiera que hubiera tenido un
-- bloqueo automático antes.
--
-- ── 3. «Desbloquear» no desbloqueaba del todo ──────────────────────────────
--
-- Limpiaba `blocked_at`, el silencio y los contadores, pero NO `blocked_until`.
-- Con un temporal vigente el cliente seguía sin poder pedir mientras el panel
-- ya lo mostraba libre.
--
-- ── LO QUE HACE ESTA MIGRACIÓN ─────────────────────────────────────────────
--
-- Los arreglos 2 y 3 son de TypeScript (limpiar `blocked_until` en los dos
-- sentidos: la decisión del dueño manda sobre cualquier automático pendiente,
-- y cuando perdona, perdona entero).
--
-- Aquí va el 1, y va en la BASE por la misma razón que ayer: es la CUARTA vez
-- que aparece un sitio con su propia copia de «¿está bloqueado?». No se
-- sincronizan cuatro reglas — se deja una. `business_blocked_contacts` llama a
-- `storefront_customer_block_state` fila por fila, así que el panel no puede
-- volver a contestar distinto que el disparador de pedidos.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.business_blocked_contacts(
  p_business_id uuid
)
returns table (
  phone     text,
  until     timestamptz,
  permanent boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.phone,
    -- ⚠️ Se leen del ESTADO, no de la columna: `blocked_until` puede estar
    -- vencido y entonces no es un plazo, es basura de un bloqueo cumplido.
    nullif(estado.value ->> 'until', '')::timestamptz as until,
    (estado.value ->> 'permanent')::boolean           as permanent
  from public.business_customers as bc
  join public.customers as c on c.id = bc.customer_id
  cross join lateral (
    select public.storefront_customer_block_state(bc.business_id, bc.customer_id) as value
  ) as estado
  where bc.business_id = p_business_id
    -- Solo los que lo están DE VERDAD ahora mismo. Un temporal cumplido deja
    -- de aparecer solo, que es justo lo que el dueño preguntaba.
    and (estado.value ->> 'blocked')::boolean
  order by c.phone;
$$;

comment on function public.business_blocked_contacts(uuid) is
  'Los contactos bloqueados AHORA de un negocio, con su plazo. Usa la misma '
  'regla que el disparador de pedidos: un temporal cumplido desaparece solo.';

revoke all on function public.business_blocked_contacts(uuid)
  from public, anon, authenticated;
grant execute on function public.business_blocked_contacts(uuid) to service_role;

-- ── Comprobación inmediata ─────────────────────────────────────────────────
do $comprobacion$
declare
  v_local    uuid;
  v_perm     uuid;
  v_temporal uuid;
  v_cumplido uuid;
  v_libre    uuid;
  v_filas    integer;
  v_hasta    timestamptz;
  v_esperm   boolean;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'panel-bloqueo-tmp', 'Panel', 'pizzeria', 'ycloud',
    '+593900333001', '+593900333001', true, 'miniapp'
  ) returning id into v_local;

  insert into public.customers (phone) values ('593900333101') returning id into v_perm;
  insert into public.customers (phone) values ('593900333102') returning id into v_temporal;
  insert into public.customers (phone) values ('593900333103') returning id into v_cumplido;
  insert into public.customers (phone) values ('593900333104') returning id into v_libre;

  -- Permanente (el del dueño), temporal vigente, temporal CUMPLIDO y libre.
  insert into public.business_customers (business_id, customer_id, blocked_at, blocked_until)
  values
    (v_local, v_perm,     now(),                    null),
    (v_local, v_temporal, now(),                    now() + interval '20 minutes'),
    (v_local, v_cumplido, now() - interval '2 hours', now() - interval '1 hour'),
    (v_local, v_libre,    null,                     null);

  select count(*) into v_filas
  from public.business_blocked_contacts(v_local);
  -- Dos y solo dos: el permanente y el temporal vigente.
  if v_filas <> 2 then
    raise exception 'el panel debía listar 2 bloqueados y listó %', v_filas;
  end if;

  -- El que CUMPLIÓ su castigo desaparece solo. Era el fallo que veía el dueño.
  if exists (
    select 1 from public.business_blocked_contacts(v_local) where phone = '593900333103'
  ) then
    raise exception 'un bloqueo temporal CUMPLIDO seguía saliendo en el panel';
  end if;

  if exists (
    select 1 from public.business_blocked_contacts(v_local) where phone = '593900333104'
  ) then
    raise exception 'un cliente sin bloquear salió en la lista';
  end if;

  -- El permanente no promete plazo; el temporal sí.
  select until, permanent into v_hasta, v_esperm
  from public.business_blocked_contacts(v_local) where phone = '593900333101';
  if not v_esperm or v_hasta is not null then
    raise exception 'el bloqueo del dueño salió con plazo o sin marcar permanente';
  end if;

  select until, permanent into v_hasta, v_esperm
  from public.business_blocked_contacts(v_local) where phone = '593900333102';
  if v_esperm or v_hasta is null then
    raise exception 'el bloqueo temporal salió sin plazo o marcado permanente';
  end if;

  delete from businesses where id = v_local;
  delete from public.customers where id in (v_perm, v_temporal, v_cumplido, v_libre);
  raise notice 'PANEL: lista solo a los bloqueados AHORA, con su plazo, y el cumplido se va solo';
end;
$comprobacion$;
