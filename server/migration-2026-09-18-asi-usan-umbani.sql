-- ═══════════════════════════════════════════════════════════════════════════
-- CÓMO USA LA GENTE EL MENÚ DE UMBANI
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pedido del dueño (2026-09-18): «qué cajones se tocan, cuáles se abandonan y
-- qué escribe la gente en la búsqueda… y lo necesitamos lo más pronto
-- posible». Tiene razón en la urgencia y no es por la pantalla: **el día que
-- no se registra no se recupera nunca**. Los reportes se pueden construir
-- después; los datos, no.
--
-- ⚠️ Hoy no queda rastro de nada de eso. `marketplace_conversations` guarda
-- DÓNDE está cada cliente ahora —una sola fila que se pisa a sí misma—, así
-- que no hay forma de saber cuántos tocaron un cajón y se fueron, ni qué
-- escribió el que no encontró nada. Justo lo que hace falta para afinar los
-- nombres de los cajones con datos y no con opiniones.
--
-- ⚠️ NO SE GUARDA NADA NUEVO DEL CLIENTE. El teléfono ya vive en `customers`
-- y aquí solo se apunta a su id; el texto que se guarda es el de la BÚSQUEDA
-- ya normalizado (sin tildes, en minúsculas y recortado), que es lo que se
-- necesita para descubrir que la gente escribe «seco de chivo» o «cena».
--
-- ⚠️ Es un registro de PRODUCTO, no de dinero: si falla, el chat sigue
-- funcionando exactamente igual. Se escribe sin esperar respuesta.

create table if not exists public.marketplace_events (
  id            uuid primary key default gen_random_uuid(),
  -- Quién. Si el cliente se borra, el evento se queda sin dueño en vez de
  -- irse: el embudo de esta semana no puede cambiar porque alguien se dé de
  -- baja mañana.
  customer_id   uuid references public.customers(id) on delete set null,
  -- Qué pasó, en los cuatro pasos que tiene el menú:
  --   menu     → vio los cajones
  --   cajon    → entró en uno (y cuál)
  --   busqueda → escribió algo (y cuántos locales salieron)
  --   local    → eligió un local y recibió su enlace
  tipo          text not null,
  category_code text,
  -- ⚠️ `cascade` y no `set null`: es la regla del proyecto para toda foránea a
  -- `businesses` —borrar un local se lleva SUS datos—, y aquí además es lo
  -- correcto: los toques a un local que ya no existe no son un dato, son
  -- ruido. El cliente sí se conserva (`set null`), porque el embudo de esta
  -- semana no puede cambiar porque alguien se dé de baja mañana.
  business_id   uuid references public.businesses(id) on delete cascade,
  consulta      text,
  resultados    integer,
  created_at    timestamptz not null default now(),
  constraint marketplace_events_datos_check check (
    tipo in ('menu', 'cajon', 'busqueda', 'local')
    and char_length(coalesce(consulta, '')) <= 80
    and (resultados is null or resultados between 0 and 1000)
  )
);

comment on table public.marketplace_events is
  'Qué hace la gente en el menú de Umbani: cajones tocados, búsquedas y locales elegidos.';

-- Todas las consultas de los reportes van por fecha, y las dos más caras
-- —cajones y búsquedas— filtran además por tipo.
create index if not exists idx_marketplace_events_fecha
  on public.marketplace_events (created_at desc);
create index if not exists idx_marketplace_events_tipo
  on public.marketplace_events (tipo, created_at desc);

alter table public.marketplace_events enable row level security;
revoke all on table public.marketplace_events from public, anon, authenticated;
grant select, insert, delete on table public.marketplace_events to service_role;

-- ⚠️ Las consultas de los reportes —embudo, cajones abandonados y búsquedas—
-- NO van aquí: llegan con la pantalla que las enseña, en su propio paso. Una
-- función en la base que no llama nadie es código muerto, y este proyecto
-- tiene un guardián que lo para (`funciones-huerfanas.test.js`). Lo urgente es
-- esta tabla: el día que no se registra no se recupera.
