-- ============================================================
-- RETIRAR EL MÓDULO DE HOSPEDAJE
-- Fecha: 2026-08-16 · Fase 1 de «Umbani solo domicilios»
-- ============================================================
--
-- Umbani se queda con domicilios. Hospedaje —inventario de habitaciones,
-- cotizaciones, holds y la estadía como venta— sale entero: no comparte una
-- sola tabla con el pedido, y por eso es lo primero que se retira.
--
-- ⚠️ ORDEN DE DESPLIEGUE INVERTIDO A PROPÓSITO: primero el CÓDIGO, después
-- esta migración. Es al revés de lo habitual y no es un descuido.
-- `admin-clients.routes.ts` insertaba `lodging_enabled` al crear un negocio,
-- así que si la columna desaparece mientras corre el código viejo, el alta de
-- clientes se rompe en producción — el mismo fallo de agosto de 2026. El
-- código nuevo, en cambio, convive sin problema con estas tablas todavía
-- presentes: simplemente las ignora.
--
-- ⚠️ DESTRUCTIVA E IRREVERSIBLE. Hacer respaldo/PITR antes de aplicarla.
-- Aquí vive el hostal de demostración; sus habitaciones, cotizaciones y holds
-- se pierden. Ningún negocio de comida tiene datos en estas tablas.
--
-- ⚠️ SÍ recrea `create_business_onboarding`, y hace falta. La versión que corre
-- HOY en producción viene de `migration-2026-08-06-tiempo-de-preparacion.sql`,
-- que inserta `lodging_enabled` en `businesses` de forma incondicional. Soltar
-- la columna sin recrearla deja la función compilando pero reventando en
-- ejecución (42703) con el primer negocio que se dé de alta: PostgreSQL no
-- valida cuerpos plpgsql al soltar una columna, así que la migración se
-- aplicaría «con éxito» y el fallo aparecería días después. Es exactamente la
-- cicatriz del alta de clientes de agosto de 2026.
--
-- El cuerpo que se escribe abajo es el VIGENTE con hospedaje quitado y nada
-- más: conserva la validación de plan, `bot_policies`, los siete días de
-- horario, el usuario dueño, la cuota y los tiempos de preparación. Misma
-- firma, así que los `grant`/`revoke` existentes siguen valiendo.
--
-- Lo que NO toca: pedidos, ventas de pedidos y mostrador, citas, catálogo,
-- motor de opciones, motor de margen ni la mini app de comida.

-- ⚠️ SIN `begin;`/`commit;` propios, a propósito. La atomicidad la pone el
-- ejecutor (`npm run migrate`), que envuelve cada archivo en su transacción y
-- anota la huella en `schema_migrations` dentro de ella. Abrirla aquí la
-- cerraría antes de tiempo y el registro quedaría fuera: esquema cambiado sin
-- constancia, que es el peor sitio donde puede quedarse una migración. Lo
-- vigila `tests/migraciones-guardian.test.js` desde el 2026-08-13.
--
-- Consecuencia buena: los seis pasos entran juntos o no entra ninguno, así que
-- no existe el estado intermedio con `sales` ya sin columna y las tablas vivas.

-- ── 1. La venta deja de apuntar a una estadía ─────────────────────────────
-- Va PRIMERO porque `sales` es la tabla del dinero y se toca lo mínimo: se
-- suelta la foránea y se retira el puntero. Ningún importe se modifica; una
-- venta que nació de una estadía conserva su total, su fecha y sus ítems.
alter table public.sales drop constraint if exists fk_sales_estadia_del_negocio;
alter table public.sales drop constraint if exists sales_lodging_request_id_fkey;
drop index if exists public.uq_sales_lodging;
alter table public.sales drop column if exists lodging_request_id;

-- ── 2. Los disparadores que cuelgan de tablas que SÍ siguen vivas ─────────
-- `businesses` se queda, así que su disparador hay que retirarlo a mano: sin
-- esto, la columna del punto 4 no se puede soltar. Los que cuelgan de tablas
-- de hospedaje se van solos con ellas en el punto 3.
drop trigger if exists trg_businesses_lodging_toggle_lock on public.businesses;

-- ── 3. Las tablas del módulo ──────────────────────────────────────────────
-- En orden de dependencia. `cascade` alcanza índices y disparadores propios;
-- la única referencia externa era la de `sales`, ya retirada en el punto 1.
drop table if exists public.lodging_blocks cascade;
drop table if exists public.lodging_requests cascade;
drop table if exists public.lodging_quotes cascade;
drop table if exists public.lodging_rate_overrides cascade;
drop table if exists public.lodging_room_types cascade;
drop table if exists public.lodging_settings cascade;

-- ── 4. La capacidad ───────────────────────────────────────────────────────
alter table public.businesses drop column if exists lodging_enabled;

-- ── 5. Las funciones que quedaron sin tabla ───────────────────────────────
-- Por NOMBRE y no por firma a propósito: varias tienen argumentos con valores
-- por defecto y una base que haya pasado por versiones intermedias puede
-- conservar sobrecargas. Un `drop function` con la firma equivocada no falla
-- —simplemente no borra— y dejaría funciones muertas apuntando a tablas que
-- ya no existen. Esto las alcanza todas.
do $$
declare
  v_funcion record;
begin
  for v_funcion in
    select p.oid::regprocedure as firma
    from pg_proc as p
    join pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname like '%lodging%'
        or p.proname = 'crear_venta_desde_estadia'
      )
  loop
    execute format('drop function if exists %s cascade', v_funcion.firma);
  end loop;
end;
$$;

-- ── 6. El onboarding, sin hospedaje ───────────────────────────────────────
-- Va DESPUÉS de soltar la columna: PostgreSQL no comprueba el cuerpo de una
-- función plpgsql al crearla, así que el orden entre ambas da igual mientras
-- entren juntas — y de eso se encarga la transacción del ejecutor.
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
