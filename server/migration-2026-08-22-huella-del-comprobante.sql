-- ============================================================
-- El comprobante deja de ser dos columnas y pasa a tener historia
-- ============================================================
--
-- Hasta hoy un pedido guardaba `payment_proof_url` y `payment_proof_public_id`:
-- DOS columnas, un solo comprobante. Eso tiene tres consecuencias que solo se
-- ven cuando pasan:
--
--   1. El segundo comprobante MACHACA al primero. Si el cliente manda una
--      foto borrosa y luego otra, la primera desaparece — y si el dueño ya
--      había mirado la borrosa, pierde la referencia de lo que vio.
--   2. No se puede saber si ese mismo comprobante ya se usó en otro pedido,
--      que es el fraude más común y el más barato de cazar.
--   3. No hay dónde guardar lo que se extraiga de la imagen.
--
-- ⚠️ Esta migración es ADITIVA. `orders.payment_proof_url` se queda y sigue
-- siendo lo que el panel enseña hoy; `attach_storefront_payment_proof` no se
-- toca. El comprobante nuevo se registra AL LADO, y mientras el análisis esté
-- apagado el flujo de siempre no cambia en nada.

-- ── 1. El comprobante, con su huella ─────────────────────────────────
create table if not exists public.payment_receipts (
  id             uuid primary key default gen_random_uuid(),
  -- Regla #1 del proyecto: toda tabla de datos de un negocio nace con su
  -- `business_id`. Aquí además importa para el aislamiento de la BÚSQUEDA de
  -- duplicados — ver el punto 3.
  business_id    uuid not null references public.businesses(id) on delete cascade,
  order_id       uuid not null references public.orders(id) on delete cascade,

  -- ── El archivo ──
  file_url       text not null,
  file_public_id text,
  mime_type      text,
  file_size      integer,

  -- ── Las huellas ──
  --
  -- `sha256_hash` caza el archivo IDÉNTICO: el cliente reenvía exactamente la
  -- misma foto. Es exacto, gratis y no falla nunca.
  --
  -- `perceptual_hash` caza la misma imagen RECORTADA, recomprimida o con otro
  -- brillo — que es lo que pasa cuando se reenvía por WhatsApp, porque el
  -- propio WhatsApp la recomprime y el SHA cambia. Lo calcula Cloudinary al
  -- subirla, así que no hace falta ninguna librería de imagen.
  sha256_hash      text not null check (sha256_hash ~ '^[0-9a-f]{64}$'),
  perceptual_hash  text,

  -- ── Lo que se extraiga de la imagen (lo llena el análisis) ──
  bank_name           text,
  sender_name         text,
  beneficiary_name    text,
  destination_account text,
  amount              numeric(12,2),
  currency            text,
  transaction_date    date,
  transaction_time    time,
  reference_number    text,
  transaction_number  text,
  ocr_raw_text        text,
  analysis_json       jsonb,

  -- ── El riesgo (lo llena el análisis) ──
  risk_score  integer,
  risk_level  text,

  -- ⚠️ NINGUNO de estos estados confirma un pago. El pago lo confirma el
  -- dueño desde su panel (`orders.payment_confirmed_at`) o, algún día, una
  -- conciliación bancaria. Un comprobante que «parece auténtico» sigue siendo
  -- una imagen: pudo editarse, generarse o reutilizarse.
  status text not null default 'pendiente_analisis',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_receipts_status_check check (
    status in (
      'pendiente_analisis',  -- acaba de llegar
      'analizado',           -- se le pasó el análisis y hay datos
      'requiere_revision',   -- el análisis falló o no pudo leerlo
      'descartado'           -- el dueño pidió otro comprobante
    )
  ),
  constraint payment_receipts_riesgo_check check (
    (risk_score is null or (risk_score >= 0 and risk_score <= 100))
    and (risk_level is null or risk_level in ('bajo', 'medio', 'alto', 'critico'))
  ),
  constraint payment_receipts_datos_check check (
    char_length(coalesce(bank_name, '')) <= 120
    and char_length(coalesce(sender_name, '')) <= 160
    and char_length(coalesce(beneficiary_name, '')) <= 160
    and char_length(coalesce(destination_account, '')) <= 60
    and char_length(coalesce(currency, '')) <= 8
    and char_length(coalesce(reference_number, '')) <= 80
    and char_length(coalesce(transaction_number, '')) <= 80
    -- El texto crudo se guarda para poder revisar qué leyó el análisis, pero
    -- acotado: un OCR sobre una foto ruidosa puede devolver páginas.
    and char_length(coalesce(ocr_raw_text, '')) <= 8000
    and (amount is null or (amount >= 0 and amount <= 999999))
  )
);

alter table public.payment_receipts enable row level security;

-- Mismo blindaje que `marketplace_conversations` y la cola de webhooks: la
-- tabla NO se expone a nadie salvo al servidor. Aquí importa especialmente,
-- porque la búsqueda de duplicados mira comprobantes de OTROS negocios (ver
-- el punto 3) y esa consulta no puede quedar al alcance de un cliente.
revoke all on table public.payment_receipts
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.payment_receipts to service_role;

create index if not exists idx_payment_receipts_pedido
  on public.payment_receipts (business_id, order_id, created_at desc);

-- Para la búsqueda de duplicados: se consulta por hash a través de TODA la
-- plataforma, así que el índice NO empieza por `business_id`.
create index if not exists idx_payment_receipts_sha
  on public.payment_receipts (sha256_hash);
create index if not exists idx_payment_receipts_phash
  on public.payment_receipts (perceptual_hash)
  where perceptual_hash is not null;
create index if not exists idx_payment_receipts_referencia
  on public.payment_receipts (reference_number)
  where reference_number is not null;

-- ── 2. Las señales de riesgo, una fila por señal ─────────────────────
--
-- Una tabla y no un array dentro del comprobante: así el panel puede pintar
-- cada señal con su gravedad, y mañana se puede contar «cuántos comprobantes
-- dispararon monto_incorrecto este mes» sin abrir un jsonb.
create table if not exists public.payment_receipt_risk_flags (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  receipt_id  uuid not null references public.payment_receipts(id) on delete cascade,
  flag_type   text not null,
  severity    text not null default 'media',
  description text,
  -- Cuánto sumó (o restó) esta señal al total. Guardarlo aquí permite
  -- explicar el score: sin esto, un 78/100 es un número sin defensa.
  points      integer not null default 0,
  created_at  timestamptz not null default now(),

  constraint payment_receipt_risk_flags_datos_check check (
    char_length(btrim(flag_type)) between 1 and 60
    and severity in ('baja', 'media', 'alta', 'critica')
    and char_length(coalesce(description, '')) <= 300
    and points >= -100 and points <= 100
  )
);

alter table public.payment_receipt_risk_flags enable row level security;
revoke all on table public.payment_receipt_risk_flags
  from public, anon, authenticated, service_role;
grant select, insert on table public.payment_receipt_risk_flags to service_role;

create index if not exists idx_receipt_flags_comprobante
  on public.payment_receipt_risk_flags (receipt_id);

-- ── 3. La auditoría: qué pasó con cada comprobante ───────────────────
--
-- ⚠️ NUNCA se sobrescribe. Cada acción es una fila: quién lo subió, qué
-- analizó el sistema, quién lo aprobó o lo rechazó y cuándo. Es lo que
-- responde «¿por qué se aceptó este pago?» tres meses después.
create table if not exists public.payment_receipt_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  receipt_id  uuid not null references public.payment_receipts(id) on delete cascade,
  -- Nulo cuando lo hizo el sistema (la subida del cliente, el análisis).
  user_id     uuid references public.client_users(id) on delete set null,
  action      text not null,
  old_status  text,
  new_status  text,
  metadata    jsonb,
  created_at  timestamptz not null default now(),

  constraint payment_receipt_audit_datos_check check (
    char_length(btrim(action)) between 1 and 60
    and (metadata is null or (
      jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384
    ))
  )
);

alter table public.payment_receipt_audit_logs enable row level security;
revoke all on table public.payment_receipt_audit_logs
  from public, anon, authenticated, service_role;
grant select, insert on table public.payment_receipt_audit_logs to service_role;

create index if not exists idx_receipt_audit_comprobante
  on public.payment_receipt_audit_logs (receipt_id, created_at desc);

-- ── 5. Cerrar las fronteras entre negocios ───────────────────────────
--
-- ⚠️ Lo cazó `verificar-fronteras.sql`, y tenía razón: con foráneas simples,
-- una fila de estas tablas podía apuntar a un pedido, un comprobante o un
-- usuario de OTRO negocio. La RPC comprueba la pertenencia del pedido, pero
-- una comprobación en código no cubre los caminos que se añadan mañana; la
-- base sí.
--
-- Se cierra con foráneas COMPUESTAS sobre `(id, business_id)`, el mismo
-- patrón que `product_variants` y `option_groups`.
create unique index if not exists uq_payment_receipts_id_business
  on public.payment_receipts (id, business_id);
create unique index if not exists uq_client_users_id_business
  on public.client_users (id, business_id);

alter table public.payment_receipts
  drop constraint if exists payment_receipts_order_id_fkey,
  drop constraint if exists payment_receipts_pedido_del_negocio_fkey;
alter table public.payment_receipts
  add constraint payment_receipts_pedido_del_negocio_fkey
  foreign key (order_id, business_id)
  references public.orders (id, business_id) on delete cascade;

alter table public.payment_receipt_risk_flags
  drop constraint if exists payment_receipt_risk_flags_receipt_id_fkey,
  drop constraint if exists payment_receipt_risk_flags_del_negocio_fkey;
alter table public.payment_receipt_risk_flags
  add constraint payment_receipt_risk_flags_del_negocio_fkey
  foreign key (receipt_id, business_id)
  references public.payment_receipts (id, business_id) on delete cascade;

alter table public.payment_receipt_audit_logs
  drop constraint if exists payment_receipt_audit_logs_receipt_id_fkey,
  drop constraint if exists payment_receipt_audit_logs_del_negocio_fkey;
alter table public.payment_receipt_audit_logs
  add constraint payment_receipt_audit_logs_del_negocio_fkey
  foreign key (receipt_id, business_id)
  references public.payment_receipts (id, business_id) on delete cascade;

-- El usuario que revisó tiene que ser del mismo negocio. `set null` para no
-- perder la auditoría si ese empleado se borra: lo que hizo sigue escrito.
alter table public.payment_receipt_audit_logs
  drop constraint if exists payment_receipt_audit_logs_user_id_fkey,
  drop constraint if exists payment_receipt_audit_logs_usuario_del_negocio_fkey;
alter table public.payment_receipt_audit_logs
  add constraint payment_receipt_audit_logs_usuario_del_negocio_fkey
  foreign key (user_id, business_id)
  references public.client_users (id, business_id) on delete set null;

-- ── 4. Registrar un comprobante y buscar si ya se usó ────────────────
--
-- Todo en UNA operación: registrar, buscar duplicados y dejar la auditoría.
-- Separado en tres consultas, dos comprobantes llegando a la vez podrían no
-- verse el uno al otro y los dos saldrían «limpios».
--
-- ⚠️ EL AISLAMIENTO, que es la decisión delicada de esta migración:
--
-- La BÚSQUEDA es global —un comprobante reutilizado en OTRO local es el
-- fraude que más importa cazar, y limitarla al negocio lo dejaría pasar—
-- pero lo que se DEVUELVE nunca nombra al otro negocio: solo dice que ya se
-- usó y en qué pedido de ESTE negocio, si lo hubo. Es el mismo criterio que
-- `marketplace_conversations`: se quita el acceso, no se parte la tabla.
--
-- Un dueño no puede llamar a esta función: solo `service_role`.
create or replace function public.register_payment_receipt(
  p_business_id uuid,
  p_order_id uuid,
  p_file_url text,
  p_file_public_id text,
  p_sha256 text,
  p_perceptual_hash text default null,
  p_mime_type text default null,
  p_file_size integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt_id uuid;
  v_mismo_archivo integer := 0;
  v_misma_imagen integer := 0;
  v_pedido_previo bigint;
  v_order_number bigint;
begin
  if p_business_id is null or p_order_id is null then
    raise exception using errcode = '22023', message = 'Faltan el negocio o el pedido';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Huella del archivo invalida';
  end if;
  if p_file_url is null or btrim(p_file_url) = '' then
    raise exception using errcode = '22023', message = 'Falta la URL del comprobante';
  end if;

  -- El pedido tiene que ser de ESTE negocio. Sin esto, un identificador de
  -- pedido ajeno colgaría un comprobante donde no debe.
  select o.order_number into v_order_number
  from public.orders o
  where o.id = p_order_id and o.business_id = p_business_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ¿Este archivo exacto ya se usó ANTES, en cualquier local?
  select count(*) into v_mismo_archivo
  from public.payment_receipts r
  where r.sha256_hash = p_sha256
    and r.order_id <> p_order_id;

  -- ¿Y la misma imagen recortada o recomprimida? WhatsApp recomprime al
  -- reenviar, así que el SHA cambia y solo el perceptual la reconoce.
  if p_perceptual_hash is not null and btrim(p_perceptual_hash) <> '' then
    select count(*) into v_misma_imagen
    from public.payment_receipts r
    where r.perceptual_hash = p_perceptual_hash
      and r.order_id <> p_order_id;
  end if;

  -- El pedido de ESTE negocio donde se usó antes, si lo hay. De otro negocio
  -- no se dice nada: que exista es información suficiente para desconfiar, y
  -- el número de pedido ajeno no es asunto de este dueño.
  select o.order_number into v_pedido_previo
  from public.payment_receipts r
  join public.orders o on o.id = r.order_id
  where (r.sha256_hash = p_sha256
      or (p_perceptual_hash is not null and r.perceptual_hash = p_perceptual_hash))
    and r.order_id <> p_order_id
    and o.business_id = p_business_id
  order by r.created_at desc
  limit 1;

  insert into public.payment_receipts (
    business_id, order_id, file_url, file_public_id,
    sha256_hash, perceptual_hash, mime_type, file_size, status
  ) values (
    p_business_id, p_order_id, p_file_url, nullif(btrim(p_file_public_id), ''),
    p_sha256, nullif(btrim(p_perceptual_hash), ''), nullif(btrim(p_mime_type), ''),
    p_file_size, 'pendiente_analisis'
  )
  returning id into v_receipt_id;

  -- La señal se deja escrita aquí mismo, no en el código: si el análisis
  -- posterior falla o está apagado, el duplicado ya quedó marcado.
  if v_mismo_archivo > 0 or v_misma_imagen > 0 then
    insert into public.payment_receipt_risk_flags (
      business_id, receipt_id, flag_type, severity, description, points
    ) values (
      p_business_id,
      v_receipt_id,
      case when v_mismo_archivo > 0 then 'archivo_duplicado' else 'imagen_duplicada' end,
      'critica',
      case
        when v_pedido_previo is not null
          then format('Este comprobante ya se usó en el pedido #%s', v_pedido_previo)
        else 'Este comprobante ya se usó en otro pedido'
      end,
      case when v_mismo_archivo > 0 then 70 else 60 end
    );
  end if;

  insert into public.payment_receipt_audit_logs (
    business_id, receipt_id, action, new_status, metadata
  ) values (
    p_business_id, v_receipt_id, 'recibido', 'pendiente_analisis',
    jsonb_build_object(
      'order_number', v_order_number,
      'duplicado_exacto', v_mismo_archivo > 0,
      'duplicado_visual', v_misma_imagen > 0
    )
  );

  return jsonb_build_object(
    'result', 'registered',
    'receipt_id', v_receipt_id,
    'duplicado', (v_mismo_archivo > 0 or v_misma_imagen > 0),
    'duplicado_exacto', v_mismo_archivo > 0,
    'duplicado_visual', v_misma_imagen > 0,
    -- Solo el pedido de este negocio. Nunca el de otro.
    'pedido_previo', v_pedido_previo
  );
end;
$$;

revoke all on function public.register_payment_receipt(
  uuid, uuid, text, text, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.register_payment_receipt(
  uuid, uuid, text, text, text, text, text, integer
) to service_role;
