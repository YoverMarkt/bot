-- ============================================================
-- MIGRACIÓN: Usuarios y permisos (sub-usuarios por negocio)
-- Fecha: 2026-06-30
-- Correr en Supabase → SQL Editor. Idempotente. No borra datos.
-- ============================================================

-- 1) Rol y permisos por usuario del panel.
--    role: 'owner' (dueño, acceso total) | 'employee' (empleado con permisos limitados)
--    permissions: lista de secciones permitidas, ej: ["catalogo","conversaciones","citas"]
alter table client_users add column if not exists role        text  not null default 'owner';
alter table client_users add column if not exists permissions jsonb default '[]';

-- Los usuarios existentes son los dueños originales → acceso total.
update client_users set role = 'owner' where role is null;

-- 2) Quién registró cada venta (habilita el reporte "ventas por vendedor").
alter table sales add column if not exists created_by uuid references client_users(id) on delete set null;

create index if not exists idx_client_users_biz on client_users(business_id);
create index if not exists idx_sales_created_by on sales(created_by);
