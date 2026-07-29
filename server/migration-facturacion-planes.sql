-- ============================================================
-- FACTURACIÓN MENSUAL AUTOMÁTICA + CATÁLOGO DE SEIS PLANES
-- Fecha: 2026-07-27
--
-- Ejecutar en Supabase → SQL Editor antes de desplegar el backend.
--
-- Esta migración:
--   • conserva íntegramente las facturas históricas y las cuotas futuras;
--   • impide nuevas cuotas duplicadas por negocio y mes;
--   • genera únicamente la cuota del mes corriente de Ecuador;
--   • factura solo negocios activos y no suspendidos;
--   • reemplaza el onboarding de 12 cuotas por una sola cuota corriente;
--   • migra únicamente el código legado premium a scale.
--
-- No elimina la columna de vencimiento ni reescribe tarifas o cobros.
-- ============================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

lock table public.businesses in share row exclusive mode;
lock table public.billing in share row exclusive mode;

-- Compatibilidad si migration-consumo-planes.sql todavía no se aplicó. Las
-- altas nuevas reciben límites explícitos según el plan; los negocios actuales
-- conservan exactamente sus límites y tarifas.
alter table public.businesses
  add column if not exists monthly_contact_limit integer,
  add column if not exists monthly_outbound_message_limit integer;

-- Una alta sin selección explícita empieza en Micro. ALTER DEFAULT no cambia
-- ninguna fila existente.
alter table public.businesses
  alter column plan set default 'micro',
  alter column monthly_contact_limit set default 50,
  alter column monthly_outbound_message_limit set default 250;

-- premium tenía exactamente la capacidad que ahora corresponde a scale.
-- No se toca monthly_rate, los límites ni ninguna factura existente.
update public.businesses
set plan = 'scale'
where lower(btrim(coalesce(plan, ''))) = 'premium';

-- Fuente de verdad del catálogo en PostgreSQL. Las RPC financieras consultan
-- esta función y rechazan cualquier tarifa o límite distinto.
create or replace function public.billing_plan_definition(p_plan text)
returns table (
  plan_code text,
  monthly_rate numeric,
  monthly_contact_limit integer,
  monthly_outbound_message_limit integer
)
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    catalog.plan_code,
    catalog.monthly_rate,
    catalog.monthly_contact_limit,
    catalog.monthly_outbound_message_limit
  from (
    values
      ('micro'::text,      25::numeric,  50,  250),
      ('basic'::text,      50::numeric, 200, 1000),
      ('pro'::text,        99::numeric, 400, 2000),
      ('growth'::text,    199::numeric, 800, 4000),
      ('scale'::text,     499::numeric, 2000, 10000),
      ('enterprise'::text, 899::numeric, 4000, 20000)
  ) as catalog (
    plan_code,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit
  )
  where catalog.plan_code = lower(btrim(coalesce(p_plan, '')));
$$;

revoke all on function public.billing_plan_definition(text)
  from public, anon, authenticated;
grant execute on function public.billing_plan_definition(text)
  to service_role;

-- Una tabla auxiliar reclama atómicamente cada combinación negocio/mes. Esto
-- permite conservar posibles duplicados históricos sin borrarlos, pero bloquea
-- cualquier duplicado nuevo incluso si dos servidores facturan a la vez.
create table if not exists public.billing_month_claims (
  business_id  uuid not null
               references public.businesses(id) on delete cascade,
  period_start date not null,
  billing_id   uuid
               references public.billing(id) on delete set null,
  claimed_at   timestamptz not null default now(),
  primary key (business_id, period_start)
);

-- Registra las cuotas existentes, incluidas las doce futuras creadas por la
-- versión anterior. DISTINCT ON conserva todas las facturas; solo elige una
-- como referencia de la clave mensual.
insert into public.billing_month_claims (
  business_id,
  period_start,
  billing_id,
  claimed_at
)
select distinct on (
  billing.business_id,
  date_trunc('month', billing.period_start)::date
)
  billing.business_id,
  date_trunc('month', billing.period_start)::date,
  billing.id,
  coalesce(billing.created_at, now())
from public.billing
where billing.period_start is not null
order by
  billing.business_id,
  date_trunc('month', billing.period_start)::date,
  billing.created_at nulls last,
  billing.id
on conflict (business_id, period_start) do nothing;

alter table public.billing_month_claims enable row level security;
revoke all on table public.billing_month_claims
  from public, anon, authenticated;
grant select on table public.billing_month_claims to service_role;

create or replace function public.claim_billing_month()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed_business_id uuid;
begin
  -- Los registros históricos sin período se preservan, pero la automatización
  -- siempre crea períodos completos y sí queda protegida.
  if new.period_start is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.business_id is not distinct from old.business_id
       and date_trunc('month', new.period_start)::date
         is not distinct from date_trunc('month', old.period_start)::date then
      return new;
    end if;
  end if;

  insert into public.billing_month_claims (
    business_id,
    period_start,
    billing_id
  ) values (
    new.business_id,
    date_trunc('month', new.period_start)::date,
    new.id
  )
  on conflict (business_id, period_start) do nothing
  returning business_id into v_claimed_business_id;

  if v_claimed_business_id is null then
    raise exception using
      errcode = '23505',
      message = 'Ya existe una cuota para este negocio y mes',
      constraint = 'billing_one_charge_per_business_month';
  end if;

  return new;
end;
$$;

revoke all on function public.claim_billing_month()
  from public, anon, authenticated;

drop trigger if exists billing_claim_month on public.billing;
create trigger billing_claim_month
before insert or update of business_id, period_start on public.billing
for each row execute function public.claim_billing_month();

-- Se invoca al arrancar el servidor y luego una vez al día. La fecha se calcula
-- siempre como calendario de Ecuador, independientemente del huso horario de
-- Railway o Supabase.
create or replace function public.ensure_current_month_billing()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
  v_business record;
  v_created integer := 0;
begin
  for v_business in
    select business.id, business.monthly_rate
    from public.businesses as business
    where business.active is true
      and coalesce(business.suspended, false) is false
      and business.monthly_rate is not null
      and business.monthly_rate > 0
  loop
    if not exists (
      select 1
      from public.billing as charge
      where charge.business_id = v_business.id
        and charge.period_start >= v_period_start
        and charge.period_start <= v_period_end
    ) then
      begin
        insert into public.billing (
          business_id,
          amount,
          currency,
          period_start,
          period_end,
          status,
          notes
        ) values (
          v_business.id,
          v_business.monthly_rate,
          'USD',
          v_period_start,
          v_period_end,
          'pending',
          'Cuota mensual automática'
        );
        v_created := v_created + 1;
      exception
        -- Otra instancia pudo reclamar el mes entre el NOT EXISTS y el INSERT.
        -- El trigger garantiza que esa carrera termina en una sola cuota.
        when unique_violation then null;
      end;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.ensure_current_month_billing()
  from public, anon, authenticated;
grant execute on function public.ensure_current_month_billing()
  to service_role;

-- Reactivar conserva la suspensión como decisión manual y emite de inmediato
-- la cuota corriente si corresponde; nunca altera una fecha de vencimiento.
create or replace function public.reactivate_business_with_billing(
  p_business_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  update public.businesses
  set suspended = false,
      bot_active = true,
      suspension_reason = null
  where id = p_business_id
  returning * into v_business;

  if not found then
    return false;
  end if;

  if v_business.active is true
     and v_business.monthly_rate is not null
     and v_business.monthly_rate > 0
     and not exists (
       select 1
       from public.billing as charge
       where charge.business_id = v_business.id
         and charge.period_start >= v_period_start
         and charge.period_start <= v_period_end
     ) then
    begin
      insert into public.billing (
        business_id,
        amount,
        currency,
        period_start,
        period_end,
        status,
        notes
      ) values (
        v_business.id,
        v_business.monthly_rate,
        'USD',
        v_period_start,
        v_period_end,
        'pending',
        'Cuota mensual automática'
      );
    exception
      when unique_violation then null;
    end;
  end if;

  return true;
end;
$$;

revoke all on function public.reactivate_business_with_billing(uuid)
  from public, anon, authenticated;
grant execute on function public.reactivate_business_with_billing(uuid)
  to service_role;

-- Cambio de plan transaccional: negocio, tarifa y límites quedan sincronizados.
-- Solo actualiza cuotas pendientes del mes corriente o posteriores; nunca toca
-- cobros pagados ni facturas de meses anteriores.
create or replace function public.update_business_plan_billing(
  p_business_id uuid,
  p_plan text,
  p_monthly_rate numeric,
  p_monthly_contact_limit integer,
  p_monthly_outbound_message_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan text := lower(btrim(coalesce(p_plan, '')));
  v_plan_definition record;
  v_business public.businesses%rowtype;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;
  if p_monthly_rate is distinct from v_plan_definition.monthly_rate
     or p_monthly_contact_limit
       is distinct from v_plan_definition.monthly_contact_limit
     or p_monthly_outbound_message_limit
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'La tarifa o los límites no coinciden con el catálogo del plan';
  end if;

  update public.businesses
  set plan = v_plan_definition.plan_code,
      monthly_rate = v_plan_definition.monthly_rate,
      monthly_contact_limit = v_plan_definition.monthly_contact_limit,
      monthly_outbound_message_limit =
        v_plan_definition.monthly_outbound_message_limit
  where id = p_business_id
  returning * into v_business;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'El negocio no existe';
  end if;

  update public.billing
  set amount = v_plan_definition.monthly_rate
  where business_id = p_business_id
    and status = 'pending'
    and period_start >= v_period_start;

  if v_business.active is true
     and coalesce(v_business.suspended, false) is false
     and not exists (
       select 1
       from public.billing as charge
       where charge.business_id = v_business.id
         and charge.period_start >= v_period_start
         and charge.period_start <= v_period_end
     ) then
    begin
      insert into public.billing (
        business_id,
        amount,
        currency,
        period_start,
        period_end,
        status,
        notes
      ) values (
        v_business.id,
        v_plan_definition.monthly_rate,
        'USD',
        v_period_start,
        v_period_end,
        'pending',
        'Cuota mensual automática'
      );
    exception
      when unique_violation then null;
    end;
  end if;

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.update_business_plan_billing(
  uuid,
  text,
  numeric,
  integer,
  integer
) from public, anon, authenticated;
grant execute on function public.update_business_plan_billing(
  uuid,
  text,
  numeric,
  integer,
  integer
) to service_role;

-- Alta atómica actualizada. Los códigos y capacidades oficiales son:
--   micro      $25  ·   50 contactos ·    250 mensajes
--   basic      $50  ·  200 contactos ·  1.000 mensajes (Inicial)
--   pro        $99  ·  400 contactos ·  2.000 mensajes
--   growth    $199  ·  800 contactos ·  4.000 mensajes
--   scale     $499  · 2000 contactos · 10.000 mensajes
--   enterprise $899 · 4000 contactos · 20.000 mensajes
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
    monthly_outbound_message_limit
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
    v_outbound_limit
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

revoke all on function public.create_business_onboarding(
  jsonb,
  text,
  text,
  numeric
) from public, anon, authenticated;
grant execute on function public.create_business_onboarding(
  jsonb,
  text,
  text,
  numeric
) to service_role;

commit;
