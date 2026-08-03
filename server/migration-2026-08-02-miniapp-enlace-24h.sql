-- ============================================================================
-- MODO MINI APP: CUÁNDO SE LE MANDÓ EL ENLACE A CADA CLIENTE
--
-- Hasta ahora esto vivía en un `Map` de JavaScript dentro del proceso
-- (`storefront-link.ts`), con 10 minutos de espera. Tres problemas:
--
--   1. Se pierde al reiniciar. Railway reinicia al desplegar, y el cliente
--      recibe el enlace otra vez como si fuera nuevo.
--   2. No sobrevive a dos instancias. En cuanto haya más de un proceso, cada
--      uno lleva su propia cuenta y el cliente recibe el enlace por duplicado.
--   3. Diez minutos es poco para la regla que hace falta: reenviar el MISMO
--      enlace cada 24 h, y entre medias solo recordar que lo use.
--
-- Se guarda en `business_customers`, que es justo la relación (negocio,
-- cliente) y ya existe. No hace falta tabla nueva.
--
-- La lectura y la marca van juntas en una función que RECLAMA el envío, igual
-- que `enqueue_webhook_event` o la cuota mensual: si dos mensajes del mismo
-- cliente entran a la vez —pasa, la gente manda tres seguidos— solo uno se
-- lleva el envío y el otro recibe el recordatorio. Hacerlo en dos pasos desde
-- Node dejaría esa carrera abierta.
--
-- Idempotente. No toca datos existentes: la columna nace nula, que significa
-- «nunca se le mandó», que es exactamente lo que pasa hoy.
-- ============================================================================

alter table public.business_customers
  add column if not exists storefront_link_sent_at timestamptz;

comment on column public.business_customers.storefront_link_sent_at is
  'Última vez que el bot le mandó a este cliente el enlace de la mini app de '
  'este negocio. Nulo = nunca. Lo gestiona claim_storefront_link_send().';

-- ── Reclamo atómico del envío ───────────────────────────────────────────────
--
-- Devuelve true si a ESTE cliente le toca recibir el enlace, y en la misma
-- operación deja marcada la fecha. Devuelve false si ya se le mandó dentro de
-- la ventana: entonces el bot responde solo con el recordatorio.
create or replace function public.claim_storefront_link_send(
  p_business_id uuid,
  p_customer_id uuid,
  p_cooldown_hours integer default 24
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reclamado boolean;
begin
  if p_business_id is null or p_customer_id is null then
    return false;
  end if;

  -- La fila de la relación puede no existir todavía si el cliente nunca pidió
  -- nada: se crea aquí para poder anotar el envío.
  insert into public.business_customers (business_id, customer_id)
  values (p_business_id, p_customer_id)
  on conflict (business_id, customer_id) do nothing;

  -- `for update` serializa a los mensajes que lleguen a la vez del mismo
  -- cliente. Sin esto, tres «hola» seguidos mandan tres enlaces.
  update public.business_customers
  set storefront_link_sent_at = now(),
      updated_at = now()
  where business_id = p_business_id
    and customer_id = p_customer_id
    and (
      storefront_link_sent_at is null
      or storefront_link_sent_at
         < now() - make_interval(hours => greatest(coalesce(p_cooldown_hours, 24), 0))
    )
  returning true into v_reclamado;

  return coalesce(v_reclamado, false);
end;
$$;

revoke all on function public.claim_storefront_link_send(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_storefront_link_send(uuid, uuid, integer)
  to service_role;

-- ── Comprobación inmediata ──────────────────────────────────────────────────
-- Se ejercita la regla entera: primera vez sí, dentro de la ventana no, y
-- pasadas las horas otra vez sí.
do $comprobacion$
declare
  v_b uuid; v_c uuid; v_r boolean;
begin
  insert into businesses (
    slug, name, type, whatsapp_provider, whatsapp_number, ycloud_number,
    takes_orders, chat_mode
  ) values (
    'enlace-24h-tmp', 'Enlace', 'tienda', 'ycloud',
    '+593900999001', '+593900999001', true, 'miniapp'
  ) returning id into v_b;

  insert into public.customers (phone) values ('593900999002') returning id into v_c;

  v_r := public.claim_storefront_link_send(v_b, v_c, 24);
  if v_r is not true then
    raise exception 'La primera vez debía reclamar el envío';
  end if;

  v_r := public.claim_storefront_link_send(v_b, v_c, 24);
  if v_r is not false then
    raise exception 'Dentro de la ventana NO debía reenviar';
  end if;

  -- Se envejece el envío 25 horas: ahora sí toca de nuevo.
  update public.business_customers
  set storefront_link_sent_at = now() - interval '25 hours'
  where business_id = v_b and customer_id = v_c;

  v_r := public.claim_storefront_link_send(v_b, v_c, 24);
  if v_r is not true then
    raise exception 'Pasadas 24 h debía reenviar';
  end if;

  delete from businesses where id = v_b;
  delete from public.customers where id = v_c;
  raise notice 'ENLACE 24H: primera vez sí, dentro de la ventana no, pasadas 24 h sí';
end;
$comprobacion$;
