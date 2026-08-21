-- ═══════════════════════════════════════════════════════════════════════════
-- UN NEGOCIO PUEDE EXISTIR SIN CANAL PROPIO
--
-- Fase 1 del marketplace: todos los clientes escribirán al MISMO número, el de
-- la plataforma, así que un local ya no necesita su propio WhatsApp, ni cuenta
-- de YCloud, ni webhook, ni Phone ID de Meta.
--
-- Hoy la base lo IMPIDE, y no con una validación blanda: al insertar un negocio
-- sin teléfono, el disparador `sync_business_channel_identifiers` llama a
-- `refresh_business_channel_identifiers`, que lanza «YCloud requiere un
-- teléfono de canal válido» y aborta el alta entera. Con esta migración el alta
-- de una cevichería de prueba deja de necesitar credenciales que no existen.
--
-- ⚠️ ES ADITIVA. `ycloud`, `meta` y `telegram` siguen exactamente igual: quien
-- tenga su propio número lo conserva y se sigue resolviendo por él. Monster
-- Pizza no cambia de comportamiento. Lo único que se añade es un cuarto
-- proveedor, `marketplace`, que significa «no tiene canal propio».
--
-- ⚠️ NO se recrean `create_storefront_order` ni `set_order_status`. Las dos
-- funciones que sí se recrean —el refresco de identificadores y el alta— son
-- justamente las que hoy rechazan un negocio sin número: no hay forma de
-- cambiar eso sin tocarlas, y se parten de su ÚLTIMA versión viva, no de
-- `schema.sql`.
--
-- ⚠️ Este negocio todavía NO recibe ni envía WhatsApp. Eso llega cuando exista
-- el estado de conversación que diga en qué local está cada cliente (fase 2),
-- porque con un solo número el teléfono ya no puede responder esa pregunta.
-- Mientras tanto es un negocio completo por la mini app y por el panel, que es
-- lo que hace falta para cargar catálogos y probar.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. El cuarto proveedor ─────────────────────────────────────────────────
--
-- `add constraint check` toma ACCESS EXCLUSIVE y recorre la tabla entera. Con
-- el tope, una sesión que tenga `businesses` abierta hace fallar la migración
-- en cinco segundos en vez de bloquear el alta de clientes durante minutos.
--
-- ⚠️ Sin `begin`/`commit` a propósito: la transacción la abre el ejecutor
-- (`tests/migraciones.mjs`), y abrir otra dejaría el registro de la migración
-- fuera de ella. Aplicado A MANO con psql, estos dos `set local` avisan
-- «SET LOCAL can only be used in transaction blocks» y no hacen nada: es
-- esperado, y la única forma soportada de aplicarla es `npm run migrate`.
set local lock_timeout = '5s';
set local statement_timeout = '2min';

alter table public.businesses
  drop constraint if exists businesses_whatsapp_provider_check;

alter table public.businesses
  add constraint businesses_whatsapp_provider_check check (
    nullif(btrim(coalesce(whatsapp_provider, '')), '') is null
    or btrim(whatsapp_provider) in ('ycloud', 'meta', 'telegram', 'marketplace')
  );


-- ── 2. Y no puede tener identificadores propios ────────────────────────────
--
-- `marketplace` significa «lo atiende el número de la plataforma». Si además
-- guardara un teléfono suyo, habría dos respuestas a «¿de quién es este
-- número?» y el enrutado dependería de cuál se mirara primero.
--
-- Es la misma idea que `option_groups_destino_check`: el estado imposible se
-- prohíbe en la base, no se confía en que nadie lo escriba.
alter table public.businesses
  drop constraint if exists businesses_marketplace_sin_canal_check;

alter table public.businesses
  add constraint businesses_marketplace_sin_canal_check check (
    btrim(coalesce(whatsapp_provider, '')) is distinct from 'marketplace'
    or (
      nullif(btrim(coalesce(whatsapp_number, '')), '') is null
      and nullif(btrim(coalesce(ycloud_number, '')), '') is null
      and nullif(btrim(coalesce(meta_phone_id, '')), '') is null
    )
  );


-- ── 3. El refresco de identificadores respeta al marketplace ───────────────
--
-- Se parte de la versión viva (`migration-identificadores-canales.sql`) y se
-- le añade UNA salida temprana. Todo lo demás —el lock por teléfono, el
-- rechazo de configuraciones parciales, el borrado y reinserción en la misma
-- transacción— queda intacto.

create or replace function public.refresh_business_channel_identifiers(
  p_business_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_candidate record;
  v_existing_business_id uuid;
  v_phone_owner_business_id uuid;
  v_whatsapp_provider text;
  v_whatsapp_phone text;
  v_ycloud_phone text;
  v_meta_account_id text;
begin
  select * into v_business
  from public.businesses
  where id = p_business_id;

  if not found then
    delete from public.business_channel_identifiers
    where business_id = p_business_id;
    return;
  end if;

  v_whatsapp_provider := coalesce(
    nullif(btrim(coalesce(v_business.whatsapp_provider, '')), ''),
    'ycloud'
  );
  -- El negocio del marketplace no tiene canal propio: lo atiende el número de
  -- la plataforma. No se le crea ningún identificador —crearlo sería declarar
  -- que un teléfono le pertenece— y se sale antes de las validaciones que
  -- exigen credenciales, que para él no aplican.
  if v_whatsapp_provider = 'marketplace' then
    delete from public.business_channel_identifiers
    where business_id = p_business_id;
    return;
  end if;

  if v_whatsapp_provider not in ('meta', 'ycloud', 'telegram', 'marketplace') then
    raise exception using
      errcode = '22023',
      message = 'El proveedor WhatsApp configurado es inválido',
      detail = format(
        'business_id=%s provider=%s', p_business_id, v_whatsapp_provider
      );
  end if;

  -- Un proveedor activo sin su identificador autoritativo dejaría el webhook
  -- sin una forma segura de determinar el tenant. Se rechaza la configuración
  -- en vez de crear un mapeo parcial o recurrir a coincidencias aproximadas.
  if v_whatsapp_provider in ('meta', 'ycloud') then
    v_whatsapp_phone := public.normalize_business_channel_identifier(
      'phone', v_business.whatsapp_number
    );
  end if;
  if v_whatsapp_provider = 'ycloud' then
    v_ycloud_phone := public.normalize_business_channel_identifier(
      'phone', v_business.ycloud_number
    );
  end if;
  if v_whatsapp_provider = 'meta' then
    v_meta_account_id := public.normalize_business_channel_identifier(
      'account_id', v_business.meta_phone_id
    );
  end if;
  if v_whatsapp_provider = 'ycloud'
    and coalesce(v_ycloud_phone, v_whatsapp_phone) is null then
    raise exception using
      errcode = '22023',
      message = 'YCloud requiere un teléfono de canal válido',
      detail = format('business_id=%s provider=ycloud', p_business_id);
  elsif v_whatsapp_provider = 'meta'
    and v_meta_account_id is null then
    raise exception using
      errcode = '22023',
      message = 'Meta requiere un Phone ID válido',
      detail = format('business_id=%s provider=meta', p_business_id);
  end if;

  -- El borrado y las inserciones viven en la misma transacción que el cambio
  -- de businesses. Una colisión revierte todo y conserva el mapeo anterior.
  delete from public.business_channel_identifiers
  where business_id = p_business_id;

  for v_candidate in
    select distinct
      candidates.provider,
      candidates.identifier_type,
      candidates.canonical_identifier
    from (
      select
        v_whatsapp_provider as provider,
        'phone'::text as identifier_type,
        v_whatsapp_phone as canonical_identifier
      where v_whatsapp_provider in ('meta', 'ycloud')

      union all

      select
        'ycloud',
        'phone',
        v_ycloud_phone
      where v_whatsapp_provider = 'ycloud'

      union all

      select
        'meta',
        'account_id',
        v_meta_account_id
      where v_whatsapp_provider = 'meta'
    ) as candidates
    where candidates.canonical_identifier is not null
    order by
      candidates.identifier_type,
      candidates.canonical_identifier,
      candidates.provider
  loop
    if v_candidate.identifier_type = 'phone' then
      -- Un teléfono completo tiene un único dueño incluso durante un cambio de
      -- proveedor. El advisory lock cierra la carrera entre dos altas paralelas.
      perform pg_advisory_xact_lock(hashtextextended(
        'business-channel-phone:' || v_candidate.canonical_identifier,
        0
      ));
      v_phone_owner_business_id := null;
      select business_id into v_phone_owner_business_id
      from public.business_channel_identifiers
      where identifier_type = 'phone'
        and canonical_identifier = v_candidate.canonical_identifier
        and business_id <> p_business_id
      limit 1;

      if v_phone_owner_business_id is not null then
        raise exception using
          errcode = '23505',
          message = 'Un teléfono de canal ya pertenece a otro negocio',
          detail = format(
            'identifier=%s existing_business_id=%s requested_business_id=%s',
            v_candidate.canonical_identifier,
            v_phone_owner_business_id,
            p_business_id
          );
      end if;
    end if;

    v_existing_business_id := null;
    select business_id into v_existing_business_id
    from public.business_channel_identifiers
    where provider = v_candidate.provider
      and identifier_type = v_candidate.identifier_type
      and canonical_identifier = v_candidate.canonical_identifier;

    if v_existing_business_id is not null
      and v_existing_business_id <> p_business_id then
      raise exception using
        errcode = '23505',
        message = 'Un identificador de canal ya pertenece a otro negocio',
        detail = format(
          'provider=%s type=%s identifier=%s existing_business_id=%s requested_business_id=%s',
          v_candidate.provider,
          v_candidate.identifier_type,
          v_candidate.canonical_identifier,
          v_existing_business_id,
          p_business_id
        );
    end if;

    if v_existing_business_id is null then
      insert into public.business_channel_identifiers (
        business_id,
        provider,
        identifier_type,
        canonical_identifier
      ) values (
        p_business_id,
        v_candidate.provider,
        v_candidate.identifier_type,
        v_candidate.canonical_identifier
      );
    end if;
  end loop;
end;
$$;

-- ── 4. El alta deja de exigir número al negocio del marketplace ────────────
--
-- Se parte de la ÚLTIMA versión viva, la de
-- `migration-2026-08-19-miniapp-exige-tienda.sql`, y se cambian tres cosas:
-- el número pasa a ser obligatorio solo para quien tiene canal propio, el
-- proveedor se resuelve una vez en una variable, y —lo importante— el número
-- se inserta con `nullif`.
--
-- ⚠️ Ese `nullif` no es cosmético: `businesses.whatsapp_number` es UNIQUE.
-- Insertando la cadena vacía, el PRIMER negocio del marketplace se crearía y
-- el SEGUNDO chocaría contra él con un error de índice único que no dice nada
-- de lo que pasó. NULL no colisiona consigo mismo; la cadena vacía sí.

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
  v_whatsapp_provider text :=
    coalesce(nullif(btrim(p_business ->> 'whatsapp_provider'), ''), 'ycloud');
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
  if v_name = '' or v_slug = '' then
    raise exception using
      errcode = '22023',
      message = 'Nombre y slug son obligatorios';
  end if;
  -- El número deja de ser obligatorio SOLO para el negocio del marketplace,
  -- que se atiende por el número de la plataforma. Para los demás sigue
  -- siéndolo: sin él, el webhook no tendría forma de saber de quién es el
  -- mensaje que acaba de llegar.
  if v_whatsapp_provider <> 'marketplace' and v_whatsapp_number = '' then
    raise exception using
      errcode = '22023',
      message = 'Un negocio con canal propio necesita su número';
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
  if v_chat_mode = 'miniapp' and (
    coalesce((p_business ->> 'takes_orders')::boolean, true) is not true
    or coalesce((p_business ->> 'storefront_enabled')::boolean, false) is not true
  ) then
    raise exception using
      errcode = '22023',
      message = 'El modo miniapp requiere pedidos y tienda habilitados';
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
    nullif(v_whatsapp_number, ''),
    v_whatsapp_provider,
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


-- Los mismos permisos que declaraban las migraciones de las que parten estas
-- dos funciones. `create or replace` conserva la ACL existente, así que sobre
-- la base viva no cambia nada; se repiten para que el archivo sea
-- autocontenido: aplicado sobre una base donde la función no exista, sin esto
-- nacería con EXECUTE para PUBLIC, y `refresh_business_channel_identifiers` es
-- `security definer`.
revoke all on function public.refresh_business_channel_identifiers(uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_business_channel_identifiers(uuid)
  to service_role;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric)
  to service_role;
