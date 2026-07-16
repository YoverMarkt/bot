---
name: base-de-datos
description: Úsala SIEMPRE (aunque no lo pidan) al crear o modificar migraciones, tablas, índices, columnas o políticas RLS en Supabase/Postgres para BotPanel. Garantiza que toda tabla nazca con business_id + RLS y que las migraciones no destruyan datos ni rompan el esquema vivo.
---

# base-de-datos

La base de datos es Supabase (Postgres) con pgvector. **No hay framework de migraciones**: los cambios de esquema se aplican a mano en el SQL Editor de Supabase. Por eso hay que ser muy cuidadoso.

## Estado real del esquema
`server/schema.sql` es la **referencia única, consolidada y actualizada** del esquema (refleja la base viva): RLS activado en todas las tablas, `bookings` con `booking_date`/`booking_time`/`duration_minutes`, `businesses` con `slogan`/`monthly_rate`/integraciones, `products` con `duration_minutes`/`embedding vector(1536)`, `bot_policies.bot_prompt`, `conversation_history.role in ('user','assistant','owner')`, tablas `conversation_sessions`/`business_schedule`/`server_settings`, y la función `match_products(...)` para RAG.

`server/migration-integraciones.sql` quedó **OBSOLETO** (marcado, solo historial — NO ejecutar; tiene el esquema viejo de `bookings`).

> Aun así, ante una duda puntual confirma con la BD (`select * ... limit 1` para ver columnas), porque el esquema se modifica a mano en Supabase y `schema.sql` podría adelantarse o atrasarse a un cambio reciente.

## Regla #1: migraciones como archivos NUEVOS
- **Nunca edites un .sql ya aplicado.** Crea uno nuevo (ej: `migration-<fecha>-<tema>.sql`) con solo el cambio.
- Usa siempre formas idempotentes: `create table if not exists`, `alter table ... add column if not exists`, `create index if not exists`.
- Entrega el SQL al usuario para que lo corra en Supabase → SQL Editor (no se aplica solo).

## Checklist — TABLA NUEVA
```sql
create table if not exists <tabla> (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,  -- aislamiento
  -- ...campos...
  created_at  timestamptz default now()
);
create index if not exists idx_<tabla>_biz on <tabla>(business_id);
alter table <tabla> enable row level security;   -- SIEMPRE
```
- [ ] `business_id` con FK y `on delete cascade`.
- [ ] Índice por `business_id`.
- [ ] **RLS habilitada.**
- [ ] Acceso vía funciones nuevas en `server/src/db/repositories/`, filtrando por `business_id` y exportadas desde `src/db/index.ts`.

## Políticas RLS (cliente y superadmin por separado)
El modelo actual: **RLS habilitada + backend con service key** (la service key bypassa RLS; el aislamiento real lo refuerza el filtrado por `business_id` en `server/src/db/`). La anon key del frontend queda **bloqueada** por RLS (no lee nada directo).
- Si se agregan políticas finas, sepáralas: una para el rol del cliente (solo SU `business_id`) y otra/explícita para superadmin/servicio. **Nunca** `using (true)`.
- No habilites acceso de la anon key a tablas con datos de negocio.

## Índices y claves foráneas
- FK a `businesses(id)` con `on delete cascade` (al borrar un negocio se limpian sus datos).
- Índice por `business_id` en toda tabla de negocio; índices compuestos para búsquedas frecuentes (ej: `(business_id, contact_phone)`, `(business_id, created_at)`).
- Para pgvector, el índice/operador ya lo maneja `match_products`; no cambiar dimensión (1536) sin revisar `embedText`.

## Cambios de esquema sin pérdida de datos
- Agregar columna → `add column if not exists` (no destruye nada).
- Renombrar/retipar → riesgoso: propón pasos (nueva columna → copiar datos → migrar código → borrar vieja), nunca un `drop` directo de algo con datos.
- **Nunca `drop table` / `drop column` con datos sin confirmación explícita** y respaldo.

## Antes de aplicar en producción
- [ ] El SQL es idempotente y reversible en lo posible.
- [ ] No borra ni vacía datos existentes.
- [ ] Se probó primero en el proyecto de desarrollo si existe.
- [ ] Los repositorios TypeScript que lo usan están listos (no dejar la BD adelantada al código ni viceversa de forma que rompa).

## Chuleta de índices (adaptada de ECC postgres-patterns a este multi-tenant)

En este proyecto casi toda consulta filtra primero por `business_id`, así que el índice compuesto empieza por ahí:

| Patrón de consulta | Índice |
|---|---|
| `where business_id = X` | `(business_id)` — el mínimo de toda tabla |
| `where business_id = X and col = Y` | compuesto `(business_id, col)` |
| `where business_id = X order by created_at desc` | `(business_id, created_at desc)` |
| `where business_id = X and fecha between ...` | `(business_id, fecha)` |
| columna `jsonb` con `@>` | `using gin (col)` |
| rangos de fechas que no deben solaparse | `using gist (...)` + `btree_gist` (ver hospedaje) |
| único por negocio (ej. nombre) | `unique (business_id, lower(nombre))` |

- Un índice sin `business_id` delante rara vez sirve aquí: Postgres no lo usará para las consultas reales del SaaS.
- Índices parciales (`where released_at is null`, `where status = 'pending'`) cuando la consulta caliente solo mira un subconjunto — ya se usan en hospedaje.
- No indexar "por si acaso": cada índice encarece cada insert/update. Justifícalo con una consulta real.

> Una migración mal hecha puede borrar datos de TODOS los negocios a la vez. Trátala con ese nivel de cuidado.
