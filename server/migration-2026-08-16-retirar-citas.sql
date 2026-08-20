-- ============================================================
-- RETIRAR LA AGENDA DE CITAS
-- Fecha: 2026-08-16 · Fase 2 de «Umbani solo domicilios»
-- ============================================================
--
-- Umbani reparte a domicilio; no agenda. Sale la tabla `bookings`, la
-- capacidad `takes_bookings`, la etiqueta ##BOOK## y la conversión de cita en
-- venta.
--
-- ⚠️ `business_schedule` SE QUEDA, y es lo importante de esta fase. Vivía en
-- el mismo módulo que las citas, pero no es de citas: decide si la tienda
-- acepta pedidos y si el bot atiende o contesta que está cerrado
-- (`services/schedule.ts`). Borrarla dejaría a Monster Pizza sin horario y con
-- la tienda cerrada o abierta a deshoras. Por eso el código movió sus dos
-- rutas y su repositorio a `schedule.routes.ts` / `repositories/schedule.ts`
-- antes de borrar el resto.
--
-- `business_schedule.slot_duration` también se queda: era la duración de cada
-- cita y ya nadie la lee ni la escribe. Soltarla obligaría a reescribir la
-- tabla de horarios de todos los negocios para no ganar nada.
--
-- ⚠️ MISMO ORDEN INVERTIDO QUE LA FASE 1: primero el CÓDIGO, después esta
-- migración. `create_business_onboarding` —la que deja viva la fase 1— inserta
-- `takes_bookings` sin condición, así que soltar la columna antes rompería el
-- alta de clientes. Por eso se recrea aquí sin esa columna y conserva el resto
-- del contrato, incluido `miniapp` y el interruptor de tienda.
--
-- ⚠️ DESTRUCTIVA E IRREVERSIBLE. Respaldo/PITR antes de aplicarla.
--
-- Lo que NO toca: pedidos, ventas de pedidos y mostrador, catálogo, motor de
-- opciones, motor de margen, la mini app y el horario de atención.

-- ── 1. La venta deja de apuntar a una cita ────────────────────────────────
-- Mismo criterio que con hospedaje: `sales` es la tabla del dinero y se toca
-- lo mínimo. Una venta nacida de una cita conserva importe, fecha e ítems.
alter table public.sales drop constraint if exists fk_sales_cita_del_negocio;
alter table public.sales drop constraint if exists sales_booking_id_fkey;
drop index if exists public.uq_sales_booking;
alter table public.sales drop column if exists booking_id;

-- ── 2. La tabla de citas ──────────────────────────────────────────────────
-- `cascade` alcanza sus índices y restricciones propias; la única referencia
-- externa era la de `sales`, ya retirada.
drop table if exists public.bookings cascade;

-- ── 3. La capacidad ───────────────────────────────────────────────────────
alter table public.businesses drop column if exists takes_bookings;

-- ── 4. Las funciones que quedaron sin tabla ───────────────────────────────
-- Por nombre, igual que en la fase 1: una firma equivocada no falla, solo deja
-- la función muerta apuntando a una tabla que ya no existe.
do $$
declare
  v_funcion record;
begin
  for v_funcion in
    select p.oid::regprocedure as firma
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_booking_if_available',
        'set_booking_status',
        'crear_venta_desde_cita'
      )
  loop
    execute format('drop function if exists %s cascade', v_funcion.firma);
  end loop;
end;
$$;

-- ── 5. El permiso pasa a llamarse por lo que hace ─────────────────────────
-- El permiso `citas` daba acceso a Citas Y a Horarios. Sin citas, lo único que
-- queda es Horarios, así que se renombra en vez de dejar a los empleados con
-- un permiso que nombra algo que ya no existe.
--
-- Se hace aquí y no en el código porque el valor está GUARDADO en cada fila de
-- `client_users`: sin esto, un empleado con `citas` perdería el acceso a los
-- horarios en silencio la próxima vez que entrara.
update public.client_users
set permissions = (
  select jsonb_agg(valor order by primera_posicion)
  from (
    select valor, min(posicion) as primera_posicion
    from (
      select
        case
          when permiso = '"citas"'::jsonb then '"horarios"'::jsonb
          else permiso
        end as valor,
        posicion
      from jsonb_array_elements(permissions)
        with ordinality as elemento(permiso, posicion)
    ) as normalizados
    group by valor
  ) as unicos
)
where jsonb_typeof(permissions) = 'array'
  and permissions @> '["citas"]'::jsonb;

-- ── 6. El onboarding, sin la capacidad de citas ───────────────────────────
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text :=
    btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text :=
    nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_chat_mode text :=
    coalesce(nullif(btrim(p_business ->> 'chat_mode'), ''), 'ai');
  v_plan text :=
    lower(coalesce(nullif(btrim(p_business ->> 'plan'), ''), 'micro'));
  v_plan_definition record;
  v_monthly_rate numeric;
  v_contact_limit integer;
  v_outbound_limit integer;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using
      errcode = '22023',
      message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using
      errcode = '22023',
      message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null
     and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using
      errcode = '22023',
      message = 'La contraseña debe llegar cifrada';
  end if;
  if v_chat_mode not in ('menu', 'ai', 'miniapp') then
    raise exception using
      errcode = '22023',
      message = 'El modo de conversación debe ser menu, ai o miniapp';
  end if;

  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;

  if p_monthly_rate is not null
     and p_monthly_rate is distinct from v_plan_definition.monthly_rate then
    raise exception using
      errcode = '22023',
      message = 'La tarifa no coincide con el catálogo del plan';
  end if;
  if nullif(p_business ->> 'monthly_contact_limit', '') is not null
     and nullif(p_business ->> 'monthly_contact_limit', '')::integer
       is distinct from v_plan_definition.monthly_contact_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de contactos no coincide con el catálogo del plan';
  end if;
  if nullif(
    p_business ->> 'monthly_outbound_message_limit',
    ''
  ) is not null
     and nullif(
       p_business ->> 'monthly_outbound_message_limit',
       ''
     )::integer
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de mensajes no coincide con el catálogo del plan';
  end if;

  v_plan := v_plan_definition.plan_code;
  v_monthly_rate := v_plan_definition.monthly_rate;
  v_contact_limit := v_plan_definition.monthly_contact_limit;
  v_outbound_limit := v_plan_definition.monthly_outbound_message_limit;

  insert into public.businesses (
    slug,
    name,
    type,
    whatsapp_number,
    whatsapp_provider,
    ycloud_api_key,
    ycloud_number,
    ycloud_webhook_endpoint_id,
    ycloud_webhook_secret,
    meta_token,
    meta_phone_id,
    telegram_bot_token,
    takes_orders,
    storefront_enabled,
    chat_mode,
    ai_provider,
    owner_phone,
    plan,
    active,
    bot_active,
    suspended,
    notes,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit,
    prep_time_minutes,
    delivery_extra_minutes
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    coalesce((p_business ->> 'storefront_enabled')::boolean, false),
    v_chat_mode,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    v_plan,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    v_monthly_rate,
    v_contact_limit,
    v_outbound_limit,
    -- Sin valor, el defecto de la columna. El servidor manda el del tipo,
    -- pero un alta hecha fuera del panel no puede quedarse sin tiempo.
    coalesce((p_business ->> 'prep_time_minutes')::int, 25),
    coalesce((p_business ->> 'delivery_extra_minutes')::int, 10)
  )
  returning * into v_business;

  insert into public.bot_policies (business_id)
  values (v_business.id);

  insert into public.business_schedule (
    business_id,
    day_of_week,
    open_time,
    close_time,
    slot_duration,
    is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_client_email is not null then
    insert into public.client_users (
      business_id,
      email,
      password_hash,
      role
    ) values (
      v_business.id,
      v_client_email,
      v_password_hash,
      'owner'
    );
  end if;

  insert into public.billing (
    business_id,
    amount,
    currency,
    status,
    period_start,
    period_end,
    notes
  ) values (
    v_business.id,
    v_monthly_rate,
    'USD',
    'pending',
    v_period_start,
    v_period_end,
    'Cuota mensual automática'
  );

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric)
  to service_role;
