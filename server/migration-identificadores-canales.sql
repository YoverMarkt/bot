-- Resolución exacta y multiempresa de Meta y YCloud.
-- La migración es aditiva, sincroniza solo el proveedor WhatsApp activo y
-- aborta por completo si un identificador canónico pertenece a dos negocios.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create table if not exists public.business_channel_identifiers (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null
                       references public.businesses(id) on delete cascade,
  provider             text not null
                       check (provider in ('meta', 'ycloud')),
  identifier_type      text not null
                       check (identifier_type in ('phone', 'account_id')),
  canonical_identifier text not null,
  created_at           timestamptz not null default now(),
  constraint business_channel_identifiers_canonical_check check (
    (
      identifier_type = 'phone'
      and canonical_identifier ~ '^[1-9][0-9]{7,14}$'
    )
    or (
      identifier_type = 'account_id'
      and canonical_identifier = btrim(canonical_identifier)
      and char_length(canonical_identifier) between 1 and 255
      and canonical_identifier !~ '[[:cntrl:]]'
    )
  )
);

create unique index if not exists uq_business_channel_identifier
  on public.business_channel_identifiers(
    provider,
    identifier_type,
    canonical_identifier
  );
create unique index if not exists uq_business_channel_phone
  on public.business_channel_identifiers(canonical_identifier)
  where identifier_type = 'phone';
create index if not exists idx_business_channel_identifiers_business
  on public.business_channel_identifiers(business_id);

alter table public.business_channel_identifiers enable row level security;
revoke all on table public.business_channel_identifiers
  from public, anon, authenticated, service_role;
grant select on table public.business_channel_identifiers to service_role;

create or replace function public.normalize_business_channel_identifier(
  p_identifier_type text,
  p_value text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_value text := btrim(p_value);
  v_canonical text;
begin
  if v_value = '' then return null; end if;

  if p_identifier_type = 'phone' then
    if v_value !~ '^\+?[0-9 ().-]+$' then
      raise exception using
        errcode = '22023',
        message = 'El teléfono del canal contiene caracteres inválidos';
    end if;
    v_canonical := regexp_replace(v_value, '[+ ().-]', '', 'g');
    if v_canonical !~ '^[1-9][0-9]{7,14}$' then
      raise exception using
        errcode = '22023',
        message = 'El teléfono del canal debe usar formato E.164 con 8 a 15 dígitos';
    end if;
    return v_canonical;
  end if;

  if p_identifier_type = 'account_id' then
    if char_length(v_value) > 255 or v_value ~ '[[:cntrl:]]' then
      raise exception using
        errcode = '22023',
        message = 'El identificador de cuenta del canal es inválido';
    end if;
    return v_value;
  end if;

  raise exception using
    errcode = '22023',
    message = 'El tipo de identificador del canal es inválido';
end;
$$;

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
  if v_whatsapp_provider not in ('meta', 'ycloud', 'telegram') then
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

create or replace function public.sync_business_channel_identifiers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_business_channel_identifiers(new.id);
  return new;
end;
$$;

revoke all on function public.normalize_business_channel_identifier(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.refresh_business_channel_identifiers(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.sync_business_channel_identifiers()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_sync_business_channel_identifiers
  on public.businesses;
create trigger trg_sync_business_channel_identifiers
after insert or update of
  whatsapp_number,
  whatsapp_provider,
  ycloud_number,
  meta_phone_id
on public.businesses
for each row
execute function public.sync_business_channel_identifiers();

-- Bloquea escrituras concurrentes mientras valida y deriva el estado vivo.
-- Ante cualquier colisión, PostgreSQL revierte toda la migración.
lock table public.businesses in share row exclusive mode;

do $$
declare
  v_business_id uuid;
begin
  for v_business_id in
    select id from public.businesses order by id
  loop
    perform public.refresh_business_channel_identifiers(v_business_id);
  end loop;
end;
$$;

commit;
