-- ============================================================
-- ⚠️ OBSOLETO — NO USAR. Conservado solo como historial.
--
-- El esquema actual y completo está en  schema.sql  (consolidado).
-- Este archivo tiene la tabla `bookings` con el esquema VIEJO
-- (start_time/end_time) que YA fue reemplazado por
-- booking_date/booking_time/duration_minutes. No lo ejecutes.
-- ============================================================
-- (Histórico) MIGRACIÓN: Integraciones YCloud, Telegram y Cal.com

-- Nuevas columnas en businesses
alter table businesses add column if not exists ycloud_api_key    text;
alter table businesses add column if not exists ycloud_number     text;
alter table businesses add column if not exists telegram_bot_token text;
alter table businesses add column if not exists calcom_link       text;

-- Establecer YCloud como proveedor predeterminado
alter table businesses alter column whatsapp_provider set default 'ycloud';

-- Tabla de reservas (Cal.com + manual)
create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  contact_phone text not null,
  contact_name  text,
  start_time    timestamptz,
  end_time      timestamptz,
  service       text,
  status        text default 'pending'
                check (status in ('pending','confirmed','cancelled','no_show')),
  calcom_uid    text,
  notes         text,
  created_at    timestamptz default now()
);

create index if not exists idx_bookings_biz     on bookings(business_id);
create index if not exists idx_bookings_contact on bookings(business_id, contact_phone);

alter table bookings disable row level security;

-- IA por cliente (null = usa la configuración global del servidor)
alter table businesses add column if not exists ai_provider text;

-- Configuración global del servidor (IA, tokens, etc.)
create table if not exists server_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

alter table server_settings disable row level security;
