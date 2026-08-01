-- Eliminación definitiva de las integraciones retiradas Kapso y Retell.
--
-- IMPORTANTE:
--   1. Ejecutar después de las migraciones históricas pendientes.
--   2. Ejecutar ANTES de migration-identificadores-canales.sql.
--   3. La eliminación de credenciales y metadatos retirados es irreversible;
--      exportarlos antes si todavía se necesita conservarlos fuera del sistema.
--
-- La migración aborta si un negocio todavía usa un proveedor retirado o no
-- soportado. Meta, YCloud y Telegram no se modifican.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

lock table public.businesses in share row exclusive mode;

do $$
declare
  v_invalid_count bigint;
  v_invalid_ids text;
begin
  select count(*)
  into v_invalid_count
  from public.businesses
  where coalesce(
    nullif(btrim(coalesce(whatsapp_provider, '')), ''),
    'ycloud'
  ) not in ('meta', 'ycloud', 'telegram');

  if v_invalid_count > 0 then
    select string_agg(candidate.id::text, ', ' order by candidate.id::text)
    into v_invalid_ids
    from (
      select id
      from public.businesses
      where coalesce(
        nullif(btrim(coalesce(whatsapp_provider, '')), ''),
        'ycloud'
      ) not in ('meta', 'ycloud', 'telegram')
      order by id
      limit 10
    ) as candidate;

    raise exception using
      errcode = '23514',
      message = 'La migración abortó: hay negocios con un proveedor retirado o no soportado',
      detail = format(
        'count=%s business_ids=%s',
        v_invalid_count,
        coalesce(v_invalid_ids, '')
      ),
      hint = 'Migra esos negocios a Meta, YCloud o Telegram y vuelve a ejecutar esta migración.';
  end if;
end;
$$;

-- Retira el sincronizador únicamente si todavía contiene lógica heredada. Si
-- este cleanup se reejecuta después del par completo, conserva intactas las
-- funciones y el trigger vigente de Meta/YCloud.
do $$
declare
  v_has_legacy_resolution boolean;
begin
  select
    exists (
      select 1
      from pg_attribute
      where attrelid = 'public.businesses'::regclass
        and attname in (
          'kapso_api_key',
          'kapso_number_id',
          'kapso_verify_token',
          'retell_agent_id'
        )
        and attnum > 0
        and not attisdropped
    )
    or exists (
      select 1
      from pg_proc
      where oid = to_regprocedure(
        'public.refresh_business_channel_identifiers(uuid)'
      )
        and pg_get_functiondef(oid) ~* '(kapso|retell)'
    )
    or exists (
      select 1
      from pg_trigger
      where tgrelid = 'public.businesses'::regclass
        and tgname = 'trg_sync_business_channel_identifiers'
        and not tgisinternal
        and pg_get_triggerdef(oid) ~* '(kapso|retell)'
    )
  into v_has_legacy_resolution;

  if v_has_legacy_resolution then
    drop trigger if exists trg_sync_business_channel_identifiers
      on public.businesses;
    drop function if exists public.sync_business_channel_identifiers();
    drop function if exists public.refresh_business_channel_identifiers(uuid);
  end if;
end;
$$;

-- Limpia identificadores derivados y reemplaza cualquier CHECK legado que
-- todavía admita proveedores retirados.
do $$
declare
  v_constraint record;
begin
  if to_regclass('public.business_channel_identifiers') is not null then
    execute $sql$
      delete from public.business_channel_identifiers
      where provider in ('kapso', 'retell')
    $sql$;

    for v_constraint in
      select conname
      from pg_constraint
      where conrelid = 'public.business_channel_identifiers'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) ~* '(kapso|retell)'
    loop
      execute format(
        'alter table public.business_channel_identifiers drop constraint %I',
        v_constraint.conname
      );
    end loop;

    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.business_channel_identifiers'::regclass
        and conname = 'business_channel_identifiers_provider_check'
    ) then
      alter table public.business_channel_identifiers
        add constraint business_channel_identifiers_provider_check
        check (provider in ('meta', 'ycloud'));
    end if;
  end if;
end;
$$;

alter table public.businesses
  alter column whatsapp_provider set default 'ycloud';

-- Los reclamos de webhook solo contienen hashes de deduplicación. Se eliminan
-- los del proveedor retirado y se conserva íntegro el historial Meta/YCloud.
do $$
declare
  v_constraint record;
begin
  if to_regclass('public.webhook_inbound_events') is not null then
    execute $sql$
      delete from public.webhook_inbound_events
      where provider in ('kapso', 'retell')
    $sql$;

    for v_constraint in
      select conname
      from pg_constraint
      where conrelid = 'public.webhook_inbound_events'::regclass
        and contype = 'c'
        and pg_get_constraintdef(oid) ~* '(kapso|retell)'
    loop
      execute format(
        'alter table public.webhook_inbound_events drop constraint %I',
        v_constraint.conname
      );
    end loop;

    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.webhook_inbound_events'::regclass
        and conname = 'webhook_inbound_events_provider_check'
    ) then
      alter table public.webhook_inbound_events
        add constraint webhook_inbound_events_provider_check
        check (provider in ('meta', 'ycloud'));
    end if;
  end if;
end;
$$;

-- Impide que un proveedor retirado vuelva a guardarse en businesses. Se
-- conserva la semántica histórica: NULL o vacío equivalen a YCloud.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~* '(kapso|retell)'
  loop
    execute format(
      'alter table public.businesses drop constraint %I',
      v_constraint.conname
    );
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_whatsapp_provider_check'
  ) then
    alter table public.businesses
      add constraint businesses_whatsapp_provider_check check (
        nullif(btrim(coalesce(whatsapp_provider, '')), '') is null
        or btrim(whatsapp_provider) in ('meta', 'ycloud', 'telegram')
      );
  end if;
end;
$$;

-- Elimina secretos globales residuales si una instalación antigua los guardó
-- en server_settings. No afecta claves de IA, Meta, YCloud ni Telegram.
do $$
begin
  if to_regclass('public.server_settings') is not null then
    execute $sql$
      delete from public.server_settings
      where lower(key) in (
        'kapso_api_key',
        'kapso_number_id',
        'kapso_verify_token',
        'retell_api_key',
        'retell_llm_secret'
      )
    $sql$;
  end if;
end;
$$;

-- Reemplaza las funciones consolidadas que antes podían referenciar campos
-- eliminados. Esta variante presupone migration-hospedaje.sql ya aplicada.
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
  v_whatsapp_number text := btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text := nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_lodging_enabled boolean := coalesce((p_business ->> 'lodging_enabled')::boolean, false);
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using errcode = '22023', message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using errcode = '22023', message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using errcode = '22023', message = 'La contraseña debe llegar cifrada';
  end if;
  if p_monthly_rate is not null and p_monthly_rate <= 0 then
    raise exception using errcode = '22023', message = 'La tarifa mensual debe ser mayor que cero';
  end if;

  insert into public.businesses (
    slug, name, type, whatsapp_number, whatsapp_provider,
    ycloud_api_key, ycloud_number, meta_token, meta_phone_id,
    meta_verify_token, telegram_bot_token,
    takes_bookings, takes_orders, lodging_enabled, ai_provider,
    owner_phone, plan, plan_expires_at,
    active, bot_active, suspended, notes, monthly_rate
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'meta_verify_token', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_bookings')::boolean, false),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    v_lodging_enabled,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    coalesce(nullif(p_business ->> 'plan', ''), 'basic'),
    nullif(p_business ->> 'plan_expires_at', '')::timestamptz,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    p_monthly_rate
  ) returning * into v_business;

  insert into public.bot_policies (business_id) values (v_business.id);

  insert into public.business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
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
    insert into public.client_users (business_id, email, password_hash, role)
    values (v_business.id, v_client_email, v_password_hash, 'owner');
  end if;

  if p_monthly_rate is not null then
    insert into public.billing (business_id, amount, status, period_start, period_end)
    select
      v_business.id,
      p_monthly_rate,
      'pending',
      (date_trunc('month', current_date) + make_interval(months => month_offset))::date,
      (date_trunc('month', current_date) + make_interval(months => month_offset + 1)
        - interval '1 day')::date
    from generate_series(0, 11) as month_offset;
  end if;

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric)
  to service_role;

create or replace function public.claim_webhook_event(
  p_business_id uuid,
  p_provider text,
  p_message_id_hash text
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if p_provider not in ('meta', 'ycloud') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook inválido';
  end if;
  if p_message_id_hash is null or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje inválido';
  end if;

  delete from public.webhook_inbound_events
  where business_id = p_business_id
    and received_at < now() - interval '24 hours';

  insert into public.webhook_inbound_events (
    business_id, provider, message_id_hash
  ) values (
    p_business_id, p_provider, p_message_id_hash
  )
  on conflict (business_id, provider, message_id_hash) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.claim_webhook_event(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.claim_webhook_event(uuid, text, text)
  to service_role;

alter table public.businesses
  drop column if exists kapso_api_key,
  drop column if exists kapso_number_id,
  drop column if exists kapso_verify_token,
  drop column if exists retell_agent_id;

commit;
