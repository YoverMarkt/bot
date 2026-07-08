-- ═══════════════════════════════════════════════════════════════════
-- MIGRACIÓN — Modo venta por negocio (¿el bot cierra pedidos?)
-- Correr UNA vez en Supabase → SQL Editor. Aditiva y NO destructiva.
--
-- true  (default) = el bot VENDE: cierra pedidos con ##PEDIDO## y el
--                   servidor envía el total oficial (pizzería, tienda…)
-- false           = SOLO INFORMATIVO: el bot asesora y deriva al asesor
--                   si el cliente quiere comprar (ej. MasPura). Blindaje:
--                   aunque el modelo emitiera ##PEDIDO##, el servidor NO
--                   crea pedidos para estos negocios.
-- ═══════════════════════════════════════════════════════════════════

alter table businesses
  add column if not exists takes_orders boolean not null default true;
