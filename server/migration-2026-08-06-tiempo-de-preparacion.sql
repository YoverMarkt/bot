-- ═══════════════════════════════════════════════════════════════════════════
-- CUÁNTO TARDA EL NEGOCIO EN TENER EL PEDIDO LISTO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy el tiempo de preparación estaba FIJO EN 30 MINUTOS para todos los
-- negocios, escrito a mano en `storefront.routes.ts` al calcular las franjas
-- de los pedidos programados. No era cosmético: ese 30 decidía la primera hora
-- a la que se podía programar en una heladería y en un asadero por igual —una
-- sirve en cinco minutos y el otro tarda cuarenta—, así que a unos les
-- ofrecíamos horas imposibles y a otros les escondíamos media hora de ventas.
--
-- Dos números, porque son dos cosas distintas y mezclarlas miente en uno de
-- los dos casos:
--   · `prep_time_minutes`      — cuánto tarda en estar LISTO. Es el que manda
--                                en las franjas y el que ve quien retira.
--   · `delivery_extra_minutes` — cuánto suma LLEVARLO a domicilio. Solo se
--                                muestra; no entra en el cálculo de franjas,
--                                porque la franja es la hora en que el pedido
--                                está listo, no en que llega.
--
-- ⚠️ El TIPO solo recomienda al crear, y jamás pisa a un negocio existente.
-- Es la misma regla de `takes_orders`, `chat_mode` y las plantillas de
-- catálogo: el valor inicial lo calcula `services/business-templates.ts` desde
-- el tipo elegido, y a partir de ahí manda el dueño desde su panel. Por eso
-- este archivo NO recorre los negocios que ya existen: los 25 minutos por
-- defecto son el arranque de los nuevos, no una corrección de los viejos.
--
-- ⚠️ Las barberías y demás negocios de CITAS no usan nada de esto. Su tiempo
-- ya lo controla el dueño desde hace tiempo y por otro camino:
-- `products.duration_minutes` (cuánto dura ese servicio),
-- `business_schedule.slot_duration` (cada cuánto se ofrece cita) y
-- `bookings.duration_minutes` (cuánto duró la cita). No se toca nada de eso.
--
-- Idempotente. Aplicar con `npm run migrate`.

-- ── 1. Los dos tiempos del negocio ────────────────────────────────────────
alter table public.businesses
  add column if not exists prep_time_minutes int not null default 25,
  add column if not exists delivery_extra_minutes int not null default 10;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_tiempos_check'
  ) then
    alter table public.businesses add constraint businesses_tiempos_check check (
      -- Un mínimo de 1: cero minutos prometería el pedido en el acto, y la
      -- franja «ahora mismo» no la puede cumplir ninguna cocina. El tope de
      -- 480 (ocho horas) deja sitio a un catering o a una torta por encargo
      -- sin permitir que un cero mal tecleado ofrezca horas de la semana que
      -- viene.
      prep_time_minutes between 1 and 480
      -- El envío SÍ puede ser cero: un negocio que solo atiende en su cuadra
      -- entrega en lo que tarda en cruzar la calle.
      and delivery_extra_minutes between 0 and 240
    );
  end if;
end;
$$;

comment on column public.businesses.prep_time_minutes is
  'Minutos hasta tener el pedido listo. Manda en las franjas programadas.';
comment on column public.businesses.delivery_extra_minutes is
  'Minutos que suma llevarlo a domicilio. Solo se muestra, no calcula franjas.';

-- ── 2. Un negocio nuevo nace con el tiempo de su tipo ─────────────────────
--
-- La FIRMA NO CAMBIA: los datos entran por el `p_business` jsonb que ya
-- recibía, así que este `create or replace` reemplaza de verdad la función en
-- vez de crear una segunda con otra firma —que es lo que pasa al añadir un
-- parámetro, dejando las dos vivas y ejecutándose la que decida PostgreSQL—.
-- Por lo mismo, los `revoke`/`grant` de la migración de onboarding siguen
-- siendo válidos y no hace falta repetirlos.
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
  v_lodging_enabled boolean :=
    coalesce((p_business ->> 'lodging_enabled')::boolean, false);
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
  if v_chat_mode not in ('menu', 'ai') then
    raise exception using
      errcode = '22023',
      message = 'El modo de conversación debe ser menu o ai';
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
    takes_bookings,
    takes_orders,
    lodging_enabled,
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
    coalesce((p_business ->> 'takes_bookings')::boolean, false),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    v_lodging_enabled,
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

  if v_lodging_enabled then
    insert into public.lodging_settings (business_id)
    values (v_business.id)
    on conflict (business_id) do nothing;
  end if;

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
