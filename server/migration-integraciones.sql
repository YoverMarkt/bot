-- ============================================================
-- MIGRACIÓN: Integraciones YCloud, Telegram, Retell, Cal.com
--
-- INSTRUCCIONES:
-- 1. Ve a supabase.com → tu proyecto → SQL Editor
-- 2. Pega este contenido y clic en RUN
-- ============================================================

-- Nuevas columnas en businesses
alter table businesses add column if not exists ycloud_api_key    text;
alter table businesses add column if not exists ycloud_number     text;
alter table businesses add column if not exists kapso_api_key     text;
alter table businesses add column if not exists telegram_bot_token text;
alter table businesses add column if not exists calcom_link       text;
alter table businesses add column if not exists retell_agent_id   text;

-- Cambiar proveedor por defecto de 'kapso' a 'ycloud'
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
