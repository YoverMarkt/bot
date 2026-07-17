-- Activa la barrera RLS que faltaba en el esquema consolidado para las
-- etiquetas de conversaciones. Es idempotente y no modifica datos.
-- APLICADA por el propietario en Supabase el 2026-07-11.
alter table if exists conversation_tags enable row level security;
