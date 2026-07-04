-- ═══════════════════════════════════════════════════════════════════
-- MIGRACIÓN — Cierre de venta / corte de historial
-- Correr UNA vez en Supabase → SQL Editor. Aditiva y NO destructiva.
-- ═══════════════════════════════════════════════════════════════════

-- Marca de tiempo del último cierre de venta de la conversación.
-- El bot ignora todo el historial anterior a este punto → trata el
-- siguiente mensaje del cliente como una conversación nueva.
alter table conversation_sessions
  add column if not exists closed_sale_at timestamptz;

-- RLS: la columna vive en 'conversation_sessions', que ya tiene RLS
-- habilitada y business_id. No requiere política nueva.
