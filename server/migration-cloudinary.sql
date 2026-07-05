-- ═══════════════════════════════════════════════════════════════════
-- MIGRACIÓN — Media de productos en Cloudinary (imágenes + videos)
-- Correr UNA vez en Supabase → SQL Editor. Aditiva y NO destructiva.
--
-- Guarda la URL pública de Cloudinary y su public_id (para poder borrar
-- el archivo cuando se reemplaza o se elimina el producto → no acumula
-- storage huérfano que gaste créditos). Todo por producto → aislamiento
-- por business_id se mantiene igual (products ya filtra por business_id).
-- ═══════════════════════════════════════════════════════════════════

alter table products add column if not exists video_url        text;   -- URL pública del video (Cloudinary)
alter table products add column if not exists image_public_id  text;   -- id del archivo de imagen en Cloudinary
alter table products add column if not exists video_public_id  text;   -- id del archivo de video en Cloudinary
