-- ============================================================
-- BOTPANEL SAAS — Schema completo para Supabase
--
-- INSTRUCCIONES:
-- 1. Ve a supabase.com → tu proyecto → SQL Editor
-- 2. Clic en "New query"
-- 3. Pega TODO este contenido
-- 4. Clic en RUN
-- 5. Debe decir "Success. No rows returned"
-- ============================================================

-- TABLA 1: Negocios (cada cliente tuyo)
create table if not exists businesses (
  id                  uuid primary key default gen_random_uuid(),
  slug                text unique not null,
  name                text not null,
  type                text,
  description         text,
  hours               text,
  address             text,
  phone               text,
  social              text,
  payment_methods     text,
  whatsapp_number     text unique,

  -- Kapso
  kapso_number_id     text,
  kapso_verify_token  text,

  -- Meta (para cuando el cliente migre de Kapso a Meta)
  meta_token          text,
  meta_phone_id       text,
  meta_verify_token   text,

  -- Proveedor activo: 'kapso' o 'meta'
  whatsapp_provider   text default 'kapso',

  -- Control de servicio
  plan                text default 'basic',
  plan_expires_at     timestamptz,
  active              boolean default true,
  bot_active          boolean default true,
  suspended           boolean default false,
  suspension_reason   text,
  notes               text,
  created_at          timestamptz default now()
);

-- TABLA 2: Usuarios del panel del cliente
create table if not exists client_users (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  email         text unique not null,
  password_hash text not null,
  name          text,
  created_at    timestamptz default now()
);

-- TABLA 3: Productos de cada negocio
create table if not exists products (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  name          text not null,
  brand         text,
  price         numeric(10,2) not null,
  price_sale    numeric(10,2),
  stock         text default 'disponible'
                check (stock in ('disponible','últimas unidades','agotado')),
  description   text,
  image_url     text,
  tags          text[] default '{}',
  external_sku  text,
  active        boolean default true,
  updated_at    timestamptz default now(),
  created_at    timestamptz default now()
);

-- TABLA 4: Políticas del bot por negocio
create table if not exists bot_policies (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid references businesses(id) on delete cascade unique,
  shipping          text,
  returns           text,
  discounts         text,
  bot_instructions  text,
  updated_at        timestamptz default now()
);

-- TABLA 5: Historial de conversaciones WhatsApp
create table if not exists conversation_history (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade,
  contact_phone   text not null,
  role            text check (role in ('user','assistant')),
  content         text not null,
  created_at      timestamptz default now()
);

-- TABLA 6: Facturación y cobros
create table if not exists billing (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  amount        numeric(10,2),
  currency      text default 'USD',
  period_start  date,
  period_end    date,
  status        text default 'pending'
                check (status in ('pending','paid','overdue')),
  paid_at       timestamptz,
  notes         text,
  created_at    timestamptz default now()
);

-- ÍNDICES
create index if not exists idx_products_biz    on products(business_id);
create index if not exists idx_history_contact on conversation_history(business_id, contact_phone);
create index if not exists idx_history_date    on conversation_history(business_id, created_at);
create index if not exists idx_biz_phone       on businesses(whatsapp_number);
create index if not exists idx_billing_biz     on billing(business_id);

-- DESHABILITAR RLS
alter table businesses           disable row level security;
alter table client_users         disable row level security;
alter table products             disable row level security;
alter table bot_policies         disable row level security;
alter table conversation_history disable row level security;
alter table billing              disable row level security;
