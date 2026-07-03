-- ============================================================
-- BOTPANEL SAAS — Schema COMPLETO y ACTUALIZADO para Supabase
--
-- Refleja el estado REAL de la base de datos (consolidado).
-- Idempotente: seguro de correr en una base nueva o existente.
--
-- INSTRUCCIONES:
--   Supabase → tu proyecto → SQL Editor → New query → pega TODO → RUN
-- ============================================================

-- Extensión para búsqueda semántica (RAG)
create extension if not exists vector;

-- ── TABLA 1: Negocios (cada cliente del SaaS) ──────────────
create table if not exists businesses (
  id                  uuid primary key default gen_random_uuid(),
  slug                text unique not null,
  name                text not null,
  type                text,
  slogan              text,
  description         text,
  hours               text,
  address             text,
  phone               text,
  social              text,
  payment_methods     text,
  -- WhatsApp personal del dueño: solo este número puede pedir reportes por WhatsApp
  owner_phone         text,
  whatsapp_number     text unique,
  -- Proveedor WhatsApp activo: 'ycloud' | 'meta' | 'kapso'
  whatsapp_provider   text default 'ycloud',
  -- YCloud
  ycloud_api_key      text,
  ycloud_number       text,
  -- Kapso
  kapso_api_key       text,
  kapso_number_id     text,
  kapso_verify_token  text,
  -- Meta
  meta_token          text,
  meta_phone_id       text,
  meta_verify_token   text,
  -- Telegram (token propio del negocio, opcional)
  telegram_bot_token  text,
  -- Integraciones
  calcom_link         text,          -- OBSOLETO (Cal.com retirado); columna huérfana, no se usa
  retell_agent_id     text,
  ai_provider         text,          -- override de IA por negocio (opcional)
  -- Modo de operación: false = solo venta/atención · true = agenda citas (calendario)
  takes_bookings      boolean not null default false,
  -- Negocio / facturación
  plan                text default 'basic',
  monthly_rate        numeric(10,2),
  plan_expires_at     timestamptz,
  active              boolean default true,
  bot_active          boolean default true,
  suspended           boolean default false,
  suspension_reason   text,
  notes               text,
  created_at          timestamptz default now()
);

-- ── TABLA 2: Usuarios del panel del cliente (dueño + empleados) ─
create table if not exists client_users (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  email         text unique not null,
  password_hash text not null,
  name          text,
  role          text not null default 'owner',   -- 'owner' | 'employee'
  permissions   jsonb default '[]',              -- secciones permitidas al empleado
  created_at    timestamptz default now()
);

-- ── TABLA 3: Productos / servicios de cada negocio ─────────
create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade,
  name            text not null,
  brand           text,
  price           numeric(10,2) not null,
  price_sale      numeric(10,2),
  stock           text default 'disponible'
                  check (stock in ('disponible','últimas unidades','agotado')),
  description     text,
  image_url       text,
  tags            text[] default '{}',
  external_sku    text,
  duration_minutes int,                 -- para negocios de servicios/citas
  embedding       vector(1536),         -- RAG (OpenAI text-embedding-3-small)
  active          boolean default true,
  updated_at      timestamptz default now(),
  created_at      timestamptz default now()
);

-- ── TABLA 4: Políticas + prompt del bot por negocio ────────
create table if not exists bot_policies (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid references businesses(id) on delete cascade unique,
  bot_prompt        text,               -- personalidad/prompt del bot
  shipping          text,
  returns           text,
  discounts         text,
  bot_instructions  text,
  updated_at        timestamptz default now()
);

-- ── TABLA 5: Historial de conversaciones ───────────────────
create table if not exists conversation_history (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade,
  contact_phone   text not null,
  role            text check (role in ('user','assistant','owner')),
  content         text not null,
  created_at      timestamptz default now()
);

-- ── TABLA 6: Sesiones (modo manual / traspaso a humano) ────
create table if not exists conversation_sessions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade,
  contact_phone   text not null,
  contact_name    text,
  manual_mode     boolean default false,
  unread_owner    boolean default false,
  last_message    text,
  last_message_at timestamptz default now(),
  unique (business_id, contact_phone)
);

-- ── TABLA 7: Horarios de atención (para reservas) ──────────
create table if not exists business_schedule (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  day_of_week   int not null,           -- 0=Domingo … 6=Sábado
  open_time     time not null default '09:00',
  close_time    time not null default '18:00',
  slot_duration int not null default 60,
  is_active     boolean default true,
  unique (business_id, day_of_week)
);

-- ── TABLA 8: Reservas / citas ──────────────────────────────
create table if not exists bookings (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade,
  contact_phone   text not null,
  contact_name    text,
  service         text,
  booking_date    date not null,
  booking_time    time not null,
  duration_minutes int,
  notes           text,
  status          text default 'pending'
                  check (status in ('pending','confirmed','cancelled','no_show')),
  created_at      timestamptz default now()
);

-- ── TABLA 9: Facturación ───────────────────────────────────
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

-- ── TABLA 10: Config global del SaaS (keys de IA, etc.) ────
-- NO es por negocio: es configuración del dueño del SaaS.
create table if not exists server_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz default now()
);

-- ── TABLA 11: Ventas (cabecera) — registro manual desde el panel ──
create table if not exists sales (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  contact_phone text,
  contact_name  text,
  total         numeric(10,2) not null default 0,
  status        text not null default 'completada' check (status in ('completada','anulada')),
  source        text default 'manual',
  created_by    uuid references client_users(id) on delete set null,  -- vendedor que la registró
  sold_at       timestamptz default now(),
  created_at    timestamptz default now()
);

-- ── TABLA 12: Ítems de cada venta (detalle, alimenta reportes) ──
create table if not exists sale_items (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid references sales(id)      on delete cascade,
  business_id  uuid references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete set null,
  product_name text not null,
  quantity     int not null default 1,
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  created_at   timestamptz default now()
);

-- ── TABLA 13: Consultas de productos (más consultados / abandonados) ──
create table if not exists product_consultations (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete cascade,
  created_at   timestamptz default now()
);

-- ── TABLA 14: Huecos de IA (preguntas que el bot no pudo responder) ──
create table if not exists ai_gaps (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id) on delete cascade,
  contact_phone text,            -- quién preguntó (contexto, opcional)
  question      text not null,   -- la pregunta que el bot no supo responder
  reason        text,            -- 'handoff' | 'uncertain'
  created_at    timestamptz default now()
);

-- ── ÍNDICES ────────────────────────────────────────────────
create index if not exists idx_products_biz      on products(business_id);
create index if not exists idx_history_contact   on conversation_history(business_id, contact_phone);
create index if not exists idx_history_date      on conversation_history(business_id, created_at);
create index if not exists idx_sessions_biz      on conversation_sessions(business_id);
create index if not exists idx_schedule_biz      on business_schedule(business_id);
create index if not exists idx_bookings_biz      on bookings(business_id);
create index if not exists idx_bookings_date     on bookings(business_id, booking_date);
create index if not exists idx_biz_phone         on businesses(whatsapp_number);
create index if not exists idx_billing_biz       on billing(business_id);
create index if not exists idx_sales_biz          on sales(business_id);
create index if not exists idx_sales_biz_date     on sales(business_id, sold_at);
create index if not exists idx_sales_biz_phone    on sales(business_id, contact_phone);
create index if not exists idx_sale_items_sale    on sale_items(sale_id);
create index if not exists idx_sale_items_biz_prod on sale_items(business_id, product_id);
create index if not exists idx_pconsult_biz_date   on product_consultations(business_id, created_at);
create index if not exists idx_pconsult_biz_prod   on product_consultations(business_id, product_id);
create index if not exists idx_ai_gaps_biz_date    on ai_gaps(business_id, created_at);

-- ── FUNCIÓN RAG: búsqueda de productos por significado ─────
create or replace function match_products(query_embedding vector(1536), biz_id uuid, match_count int)
returns table (
  id uuid, name text, brand text, price numeric, price_sale numeric,
  stock text, description text, tags text[], image_url text, duration_minutes int, similarity float
)
language sql stable as $$
  select p.id, p.name, p.brand, p.price, p.price_sale, p.stock,
         p.description, p.tags, p.image_url, p.duration_minutes,
         1 - (p.embedding <=> query_embedding) as similarity
  from products p
  where p.business_id = biz_id and p.active = true and p.embedding is not null
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

-- ── ROW LEVEL SECURITY (RLS) ───────────────────────────────
-- RLS ACTIVADO en todas las tablas. El backend usa la SERVICE KEY
-- (la bypassa); el aislamiento real lo refuerza el filtrado por
-- business_id en db.js. La anon key del frontend queda BLOQUEADA
-- (no lee datos directo) → por eso el frontend usa polling vía API.
alter table businesses            enable row level security;
alter table client_users          enable row level security;
alter table products              enable row level security;
alter table bot_policies          enable row level security;
alter table conversation_history  enable row level security;
alter table conversation_sessions enable row level security;
alter table business_schedule     enable row level security;
alter table bookings              enable row level security;
alter table billing               enable row level security;
alter table server_settings       enable row level security;
alter table sales                 enable row level security;
alter table sale_items            enable row level security;
alter table product_consultations enable row level security;
alter table ai_gaps               enable row level security;

-- ============================================================
-- NOTA: el archivo migration-integraciones.sql quedó OBSOLETO.
-- Este schema.sql es la referencia única y actual del esquema.
-- ============================================================
