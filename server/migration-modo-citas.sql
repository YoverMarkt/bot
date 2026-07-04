-- ═══════════════════════════════════════════════════════════════════
-- MIGRACIÓN — Modo de operación por negocio (Normal / Con citas)
-- Correr UNA vez en Supabase → SQL Editor.
-- Aditiva y NO destructiva: agrega una columna y rellena valores; no borra nada.
-- ═══════════════════════════════════════════════════════════════════

-- 1) Columna nueva: ¿este negocio agenda citas?
--    false = solo venta/atención (tienda, perfumería, distribuidora de agua…)
--    true  = activa el calendario de reservas (barbería, clínica, spa…)
alter table businesses
  add column if not exists takes_bookings boolean not null default false;

-- 2) Backfill seguro: activa "Con citas" en los negocios cuyo tipo ya lo sugería,
--    para no romper los que hoy ya reservan (misma lista que server/calendar.js).
--    Los demás quedan en false (Normal) por el default.
update businesses
set takes_bookings = true
where takes_bookings = false
  and lower(coalesce(type, '')) ~ '(barber|peluqu|sal[oó]n|spa|masaj|est[eé]tic|u[ñn]as|maquill|cl[ií]nic|consultorio|m[eé]dic|dentist|odonto|fisio|psico|gym|gimnas|entrenad|yoga|pilates|restaurante|caf[eé]|cafeter|reserva|hotel)';

-- RLS: la columna vive en 'businesses', que ya tiene RLS habilitada. No requiere política nueva.
