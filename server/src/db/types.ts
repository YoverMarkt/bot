// Formas de los datos que devuelve la capa `db`.
//
// Viven aquí y no en cada repositorio por una razón muy concreta: los
// repositorios usan `export =` (interoperabilidad con CommonJS) y eso no admite
// `export interface` al lado. Sin un sitio donde nombrarlos, TypeScript no
// puede inferir el tipo del compositor `db/index.ts` — y ahí empezaba el
// problema que obligaba a cada consumidor a AFIRMAR su interfaz con `as`,
// que el compilador no comprueba (ver PR del 2026-08-02).

/**
 * Una fila real de `businesses`, columna por columna.
 *
 * Antes esto era `Record<string, unknown>` —una bolsa suelta— y por eso NADIE
 * podía comprobar nada: cada archivo declaraba su propia interfaz estrecha y la
 * afirmaba con `as`, que el compilador se cree sin mirar. Así se coló en
 * producción un `issueLink` que no existía (2026-08-02).
 *
 * Las columnas salen del esquema real (`npm run verify:drift` las compara).
 * Lo opcional es opcional aquí porque lo es en la base: si escribes
 * `business.ycloud_api_key` sin comprobarlo, TypeScript ahora te lo dice.
 */
export interface BusinessRecord {
  id: string
  slug: string
  name: string
  type?: string | null
  description?: string | null
  hours?: string | null
  address?: string | null
  phone?: string | null
  social?: string | null
  payment_methods?: string | null
  whatsapp_number?: string | null
  whatsapp_provider?: string | null
  meta_token?: string | null
  meta_phone_id?: string | null
  ycloud_api_key?: string | null
  ycloud_number?: string | null
  ycloud_webhook_endpoint_id?: string | null
  ycloud_webhook_secret?: string | null
  telegram_bot_token?: string | null
  calcom_link?: string | null
  ai_provider?: string | null
  slogan?: string | null
  owner_phone?: string | null
  notes?: string | null
  plan?: string | null
  // Nota: la columna de vencimiento del plan existe en la base pero el
  // producto NO la usa; se retiró junto con los cobros automáticos y un
  // guardián de tests impide que vuelva a aparecer en el código.
  monthly_rate?: number | null
  monthly_contact_limit?: number | null
  monthly_outbound_message_limit?: number | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
  suspension_reason?: string | null
  created_at?: string | null
  // Capacidades: fuente de verdad de qué sabe hacer el negocio.
  takes_bookings: boolean
  takes_orders: boolean
  lodging_enabled: boolean
  storefront_enabled: boolean
  chat_mode: string
}

/**
 * Lo que devuelve una escritura de Supabase: o hay dato y no hay error, o al
 * revés. Nunca las dos cosas.
 *
 * Es una UNIÓN y no `{ data: T | null; error: E | null }` a propósito: así, a
 * quien ya escribe `if (error) return …` le basta esa línea para que TypeScript
 * sepa que `data` dejó de ser nulo. Con el objeto suelto haría falta una
 * segunda comprobación que el código no necesita y que nadie escribiría.
 */
export type WriteResult<T> =
  | { data: T; error: null }
  | { data: null; error: { message: string } }

/**
 * Una consulta de producto con el nombre del producto incrustado.
 *
 * `products` es UN objeto, no una lista: la consulta va de muchos a uno
 * (`product_consultations.product_id` → `products`) y PostgREST devuelve el
 * registro suelto. Se anota a mano porque, sin los tipos generados de la base,
 * el SDK supone lista para cualquier relación incrustada y se equivoca.
 */
export interface ConsultationRow {
  product_id?: string | null
  products?: { name?: string | null } | null
}

export interface PendingSession {
  contact_phone?: string | null
  last_message_at?: string | null
}

export interface PlatformErrorRow {
  id: string
  business_id: string | null
  category: string
  code: string | null
  message: string
  context: Record<string, unknown>
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}

type ScheduleData = Record<string, unknown>

export interface ScheduleRecord extends ScheduleData {
  day_of_week: number
  open_time: string
  close_time: string
  slot_duration?: number | null
  is_active?: boolean | null
}

export interface TagData {
  name: string
  color?: unknown
}
