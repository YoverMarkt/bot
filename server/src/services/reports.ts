// ============================================================
// reports.ts — Reportes de ventas para el DUEÑO del negocio.
// Dos superficies comparten la MISMA lógica de cálculo:
//   1) WhatsApp: handleOwnerMessage() → texto plano (valida owner_phone).
//   2) Panel web: getAllReports() → datos JSON para renderizar tablas/tarjetas.
// Todo filtrado por business_id (aislamiento multi-tenant).
// ============================================================
type ReportPeriod = 'hoy' | 'semana' | 'mes'
// ⚠️ Aquí vivían 'most_consulted', 'abandoned' y 'ai', y se fueron el
// 2026-09-18 con sus tres tablas muertas: `product_consultations` (2 filas, la
// última del 2026-08-03), `ai_gaps` (0) y `conversation_history` (parada el
// 2026-08-23). Las escribía el bot por chat, retirado en #360/#361 — desde
// entonces el dueño abría cuatro tarjetas vacías para siempre.
type ReportName = 'summary' | 'top' | 'low_movement' | 'comparison' | 'recurring'
  | 'low_stock' | 'pending' | 'seller'
  | 'lost' | 'customers' | 'umbani'

interface ReportIntent {
  report: ReportName
  period: ReportPeriod | null
}

interface SaleItemRow {
  quantity?: number | string | null
  line_total?: number | string | null
  product_name?: string | null
  product_id?: string | null
}

interface SaleRow {
  /** Lo que pagó el CLIENTE. No es lo que recibe el local. */
  total?: number | string | null
  /** La carrera, congelada al vender. De quien entrega. */
  shipping?: number | string | null
  /** Lo que se llevó la plataforma, congelado al vender. */
  platform_markup?: number | string | null
  sale_items?: SaleItemRow[] | null
  contact_phone?: string | null
  contact_name?: string | null
  sold_at: string
  created_by?: string | null
}

/**
 * Lo que le entra al local por una venta: SUS PRODUCTOS.
 *
 * ⚠️ Esto es lo que va a los reportes, y no `sales.total`. Pedido por el dueño
 * el 2026-09-21: «sobre los reportes tiene que ir solo lo que el dueño recibe,
 * no con mi margen de ganancia»; y antes, sobre la carrera: «eso es del
 * motorizado».
 *
 * `sales.total` es lo que pagó el CLIENTE y lleva dentro dos dineros ajenos.
 * Medido contra producción, Monster Pizza en agosto:
 *
 *     «Total vendido» que veía .......... $112.32
 *     de comida vendió de verdad ........  $94.12
 *     carreras (de quien entrega) .......  $16.00
 *     comisión de la plataforma .........   $2.20
 *
 * $18.20 de diferencia en un mes flojo — y ese es el número con el que el dueño
 * paga a su cocinero y decide si le dio el mes.
 *
 * ⚠️ Las dos partes vienen CONGELADAS en la venta, no unidas desde `orders`:
 * una venta es un hecho consumado y lo que se llevó la plataforma ese día no
 * puede cambiar porque mañana se edite una regla. Las ventas anteriores al
 * 2026-09-23 se rellenaron desde su pedido en la migración.
 *
 * ⚠️ En centavos enteros, como el resto del dinero de este proyecto: restar en
 * coma flotante deja céntimos colgando que luego no cuadran con Finanzas.
 */
const loDelLocal = (venta: SaleRow): number => Math.round(
  (Number(venta.total || 0) * 100)
  - (Number(venta.shipping || 0) * 100)
  - (Number(venta.platform_markup || 0) * 100),
) / 100

interface ClientUserRow { id: string; name?: string | null; email?: string | null }
interface ProductRow { id?: string | null; name: string; stock?: string | null }
interface SessionRow {
  contact_phone?: string | null
  contact_name?: string | null
  last_message?: string | null
  last_message_at?: string | null
}
interface ConsultationRow { product_id?: string | null; products?: { name?: string | null } | null }
interface HistoryRow { contact_phone?: string | null; role?: string | null; created_at: string }
interface UserMessageRow { content?: string | null }
interface AiGapRow { question?: string | null }

interface ReportsDatabase {
  /** El camino del cliente de ESTE local: del enlace al pedido entregado. */
  getLocalFunnel(
    businessId: string,
    dias?: number,
  ): Promise<{ paso: string; orden: number; clientes: number }[]>
  /** Por qué cajón del menú de Umbani llegaron a este local. */
  getLocalArrivals(
    businessId: string,
    dias?: number,
  ): Promise<{ code: string; label: string; veces: number }[]>
  getSalesWithItems(businessId: string, from?: string, to?: string): Promise<SaleRow[]>
  getSaleCustomers(businessId: string): Promise<SaleRow[]>
  getWritersInRange(businessId: string, from?: string, to?: string): Promise<number>
  getClientUsers(businessId: string): Promise<ClientUserRow[]>
  getProducts(businessId: string): Promise<ProductRow[]>
  getSessions(businessId: string): Promise<SessionRow[]>
  getLowStockProducts(businessId: string): Promise<ProductRow[]>
  getPendingOrders(businessId: string): Promise<SessionRow[]>
  getConsultationsInRange(businessId: string, from?: string, to?: string): Promise<ConsultationRow[]>
  getHistoryInRange(businessId: string, from?: string, to?: string): Promise<HistoryRow[]>
  getCustomerSales(businessId: string): Promise<SaleRow[]>
  getUserMessagesInRange(businessId: string, from?: string, to?: string): Promise<UserMessageRow[]>
  getAiGaps(businessId: string, from?: string, to?: string): Promise<AiGapRow[]>
}

interface OwnerBusiness { id: string; owner_phone?: string | null }

const db: ReportsDatabase = require('../db') as typeof import('../db')

const money = (n: unknown) => '$' + (Number(n) || 0).toFixed(2)

// `key9` conserva la agrupación histórica de clientes en reportes. La
// autorización del dueño es distinta: exige el identificador completo para que
// dos países (o un valor corto) nunca colisionen por sufijo.
const digits = (s: unknown) => String(s || '').replace(/\D/g, '')
const key9 = (s: unknown) => digits(s).slice(-9)
function canonicalOwnerIdentifier(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (/^tg_-?\d+$/i.test(raw)) return raw.toLowerCase()
  if (!/^\+?[0-9 ().-]+$/.test(raw)) return null
  const phone = raw.replace(/[+ ().-]/g, '')
  return /^[0-9]{8,15}$/.test(phone) ? phone : null
}
function samePhone(a: unknown, b: unknown) {
  const x = canonicalOwnerIdentifier(a)
  const y = canonicalOwnerIdentifier(b)
  return x !== null && x === y
}

// ── Rangos de fecha por período ───────────────────────────
function rangeFor(period?: ReportPeriod | null) {
  const now = new Date()
  const start = new Date(now)
  let label
  if (period === 'hoy')        { start.setHours(0, 0, 0, 0);            label = 'hoy' }
  else if (period === 'semana'){ start.setDate(start.getDate() - 7);   label = 'esta semana' }
  else                         { start.setMonth(start.getMonth() - 1); label = 'este mes' }
  return { start: start.toISOString(), end: now.toISOString(), label }
}
function previousRange(period?: ReportPeriod | null) {
  const { start, end } = rangeFor(period)
  const s = new Date(start).getTime(), e = new Date(end).getTime()
  const win = e - s
  return { start: new Date(s - win).toISOString(), end: new Date(s).toISOString() }
}

// ── Detección de intención del dueño (para WhatsApp) ──────
const REPORTS_TIME_BOUND = ['summary', 'top', 'low_movement', 'comparison', 'recurring', 'seller', 'lost', 'umbani']
function detectReportIntent(text: unknown): ReportIntent | null {
  const t = String(text || '').toLowerCase()
  const has = (...ws: string[]) => ws.some(w => t.includes(w))
  let report: ReportName | null = null
  // ⚠️ «Qué preguntan», «abandonados» y el reporte de IA los contestaba el bot
  // por chat, retirado en #360/#361, y sus tres tablas llevan meses muertas.
  // En vez de dejar mudo al dueño —que escribe lo que siempre escribió—, esas
  // mismas palabras llevan ahora a lo que SÍ se puede saber: cómo llegan sus
  // clientes desde Umbani, y qué se vende.
  if      (has('reporte de ia', 'reporte ia', 'reporte de inteligencia', 'preguntas frecuentes', 'preguntas mas frecuentes', 'preguntas sin responder', 'qué preguntan', 'que preguntan', 'cómo llegan', 'como llegan', 'de dónde vienen', 'de donde vienen', 'umbani')) report = 'umbani'
  else if (has('abandonad', 'consultado sin', 'interés sin', 'interes sin', 'preguntan pero no compran', 'no se cerr')) report = 'umbani'
  else if (has('más consultad', 'mas consultad', 'más preguntad', 'mas preguntad', 'consultado', 'preguntan por', 'más interesados', 'mas interesados')) report = 'top'
  else if (has('cliente perdido', 'clientes perdidos', 'clientes que no compr', 'no me compraron', 'no compraron', 'nunca compr', 'se perdieron', 'oportunidades perdidas', 'clientes que preguntaron')) report = 'lost'
  else if (has('vendedor', 'vendedores', 'por empleado', 'cada empleado', 'quién vendió', 'quien vendio')) report = 'seller'
  else if (has('comparar', 'comparación', 'comparacion', 'crecimiento', 'creció', 'crecio', ' vs ', 'versus')) report = 'comparison'
  else if (has('cliente frecuente', 'clientes frecuentes', 'mejores clientes', 'quién compra', 'quien compra', 'recurrente', 'fideliz')) report = 'recurring'
  else if (has('mis clientes', 'resumen de clientes', 'cuántos clientes', 'cuantos clientes', 'cartera de cliente', 'base de clientes', 'directorio de cliente', 'clientes inactivos', 'clientes en riesgo', 'clientes activos', 'reactivar')) report = 'customers'
  else if (has('menos vendido', 'bajo movimiento', 'no se vende', 'se vende poco', 'poco movimiento', 'liquidar', 'para promoción', 'para promocion')) report = 'low_movement'
  else if (has('más vendido', 'mas vendido', 'top producto', 'productos top', 'mejor producto', 'qué se vende', 'que se vende')) report = 'top'
  else if (has('stock', 'inventario', 'agotad', 'sin existencia', 'por acabarse', 'por agotarse')) report = 'low_stock'
  else if (has('pendiente', 'cotización', 'cotizacion', 'cotizaciones', 'sin cerrar', 'no cerr', 'ventas perdidas', 'recuperar')) report = 'pending'
  else if (has('resumen', 'cuánto vendí', 'cuanto vendi', 'cuánto vendimos', 'cuanto vendimos', 'total vendido', 'ventas', 'reporte', 'ticket promedio')) report = 'summary'
  if (!report) return null
  let period: ReportPeriod | null = null
  if      (has('hoy', 'día de hoy', 'dia de hoy')) period = 'hoy'
  else if (has('semana', 'semanal'))                period = 'semana'
  else if (has('mes', 'mensual', 'este mes'))       period = 'mes'
  return { report, period }
}

// ══════════════════════════════════════════════════════════
// CÁLCULO — devuelven datos estructurados (fuente única)
// ══════════════════════════════════════════════════════════

async function computeSummary(bizId: string, period?: ReportPeriod | null, preloadedSales?: SaleRow[]) {
  const { start, label } = rangeFor(period)
  const [sales, allCustomers, writers] = await Promise.all([
    preloadedSales ?? db.getSalesWithItems(bizId, start),
    db.getSaleCustomers(bizId),
    db.getWritersInRange(bizId, start)
  ])
  const total = sales.reduce((s, v) => s + loDelLocal(v), 0)
  const items = sales.reduce((s, v) => s + (v.sale_items || []).reduce((a, i) => a + Number(i.quantity || 0), 0), 0)

  // Compradores distintos del período
  const periodBuyers = new Set(sales.map(v => key9(v.contact_phone)).filter(Boolean))
  // Primera compra (histórica) de cada cliente → para "clientes nuevos"
  const firstBuy: Record<string, number> = {}
  for (const c of allCustomers) {
    const customerKey = key9(c.contact_phone)
    if (!customerKey) continue
    const t = new Date(c.sold_at).getTime()
    if (!(customerKey in firstBuy) || t < firstBuy[customerKey]) firstBuy[customerKey] = t
  }
  const startT = new Date(start).getTime()
  let nuevos = 0
  for (const ph of periodBuyers) if ((firstBuy[ph] ?? 0) >= startT) nuevos++
  // Recurrentes (histórico): clientes con 2+ compras en total
  const countByCust: Record<string, number> = {}
  for (const c of allCustomers) {
    const customerKey = key9(c.contact_phone)
    if (customerKey) countByCust[customerKey] = (countByCust[customerKey] || 0) + 1
  }
  const recurrentes = Object.values(countByCust).filter(n => n >= 2).length
  // Conversión: compradores del período ÷ clientes que escribieron
  const conversion = writers > 0 ? Math.min(100, (periodBuyers.size / writers) * 100) : null

  return {
    label, orders: sales.length, total, items, avg: sales.length ? total / sales.length : 0,
    nuevos, recurrentes, conversion, buyers: periodBuyers.size, writers
  }
}

async function computeBySeller(bizId: string, period?: ReportPeriod | null, preloadedSales?: SaleRow[]) {
  const { start, label } = rangeFor(period)
  const [sales, users] = await Promise.all([preloadedSales ?? db.getSalesWithItems(bizId, start), db.getClientUsers(bizId)])
  const nameById: Record<string, string> = {}
  users.forEach(u => { nameById[u.id] = u.name || u.email || 'Usuario' })
  const map: Record<string, { name: string; orders: number; total: number }> = {}
  for (const v of sales) {
    const key = v.created_by || 'sin_asignar'
    const name = v.created_by ? (nameById[v.created_by] || 'Usuario') : 'Sin asignar'
    if (!map[key]) map[key] = { name, orders: 0, total: 0 }
    map[key].orders += 1
    map[key].total += loDelLocal(v)
  }
  return { label, rows: Object.values(map).sort((a, b) => b.total - a.total) }
}

async function computeTop(bizId: string, period?: ReportPeriod | null, limit = 5, preloadedSales?: SaleRow[]) {
  const { start, label } = rangeFor(period)
  const sales = preloadedSales ?? await db.getSalesWithItems(bizId, start)
  const map: Record<string, { name: string; qty: number; rev: number }> = {}
  for (const v of sales) for (const i of (v.sale_items || [])) {
    const k = i.product_name || 'Producto'
    if (!map[k]) map[k] = { name: k, qty: 0, rev: 0 }
    map[k].qty += Number(i.quantity || 0)
    map[k].rev += Number(i.line_total || 0)
  }
  return { label, rows: Object.values(map).sort((a, b) => b.qty - a.qty).slice(0, limit) }
}

async function computeLowMovement(bizId: string, period?: ReportPeriod | null, threshold = 0, preloadedSales?: SaleRow[]) {
  const { start, label } = rangeFor(period)
  const [sales, products] = await Promise.all([preloadedSales ?? db.getSalesWithItems(bizId, start), db.getProducts(bizId)])
  const soldById: Record<string, number> = {}
  const soldByName: Record<string, number> = {}
  for (const v of sales) for (const i of (v.sale_items || [])) {
    const quantity = Number(i.quantity || 0)
    if (i.product_id) soldById[i.product_id] = (soldById[i.product_id] || 0) + quantity
    else {
      const name = (i.product_name || '').toLowerCase()
      soldByName[name] = (soldByName[name] || 0) + quantity
    }
  }
  const rows = products
    .map(p => ({
      name: p.name,
      qty: (p.id ? soldById[p.id] : 0) || soldByName[(p.name || '').toLowerCase()] || 0,
    }))
    .filter(p => p.qty <= threshold).sort((a, b) => a.qty - b.qty).slice(0, 12)
  return { label, threshold, rows }
}

async function computeComparison(bizId: string, period?: ReportPeriod | null, preloadedSales?: SaleRow[]) {
  const cur = rangeFor(period), prev = previousRange(period)
  const [curSales, prevSales] = await Promise.all([
    preloadedSales ?? db.getSalesWithItems(bizId, cur.start),
    db.getSalesWithItems(bizId, prev.start, prev.end)
  ])
  const sum = (arr: SaleRow[]) => arr.reduce((s, v) => s + loDelLocal(v), 0)
  const curTotal = sum(curSales), prevTotal = sum(prevSales)
  const pct = prevTotal === 0 ? null : ((curTotal - prevTotal) / prevTotal) * 100
  return { label: cur.label, curTotal, curOrders: curSales.length, prevTotal, prevOrders: prevSales.length, pct }
}

async function computeRecurring(bizId: string, period?: ReportPeriod | null, topN = 5, preloadedSales?: SaleRow[]) {
  const { start, label } = rangeFor(period)
  const [sales, sessions] = await Promise.all([preloadedSales ?? db.getSalesWithItems(bizId, start), db.getSessions(bizId)])
  const sessName: Record<string, string> = {}
  for (const s of sessions) if (s.contact_phone && s.contact_name) sessName[key9(s.contact_phone)] = s.contact_name
  const map: Record<string, { name: string; orders: number; total: number }> = {}
  for (const v of sales) {
    const k = key9(v.contact_phone) || 's/n'
    if (!map[k]) map[k] = { name: sessName[key9(v.contact_phone)] || v.contact_name || v.contact_phone || 'Cliente', orders: 0, total: 0 }
    map[k].orders += 1
    map[k].total += loDelLocal(v)
  }
  return { label, rows: Object.values(map).sort((a, b) => b.orders - a.orders).slice(0, topN) }
}

async function computeLowStock(bizId: string) {
  const list = await db.getLowStockProducts(bizId)
  return { rows: list.map(p => ({ name: p.name, stock: p.stock })) }
}

async function computePending(bizId: string) {
  const list = await db.getPendingOrders(bizId)
  return { count: list.length, rows: list.slice(0, 15).map(s => ({ name: s.contact_name || s.contact_phone, last_message: s.last_message || '' })) }
}

// Clientes perdidos: escribieron en el período pero NO compraron en él.
// Razón automática "No respondió" cuando el negocio (assistant/owner) habló al final.
// Badge: 🔁 ya fue cliente (compró alguna vez) vs 🆕 nuevo (nunca compró).
async function computeLostCustomers(bizId: string, period?: ReportPeriod | null, limit = 50, preloadedSales?: SaleRow[]) {
  const { start, label } = rangeFor(period)
  const [history, periodSales, allBuyers, sessions] = await Promise.all([
    db.getHistoryInRange(bizId, start),
    preloadedSales ?? db.getSalesWithItems(bizId, start),
    db.getSaleCustomers(bizId),
    db.getSessions(bizId)
  ])
  // Compradores del período (excluir) y de siempre (para el badge)
  const boughtInPeriod = new Set(periodSales.map(v => key9(v.contact_phone)).filter(Boolean))
  const boughtEver     = new Set(allBuyers.map(c => key9(c.contact_phone)).filter(Boolean))
  // Nombre por teléfono desde sesiones
  const sessName: Record<string, string> = {}
  for (const s of sessions) if (s.contact_phone && s.contact_name) sessName[key9(s.contact_phone)] = s.contact_name
  // Agrupar el historial por contacto
  const byContact: Record<string, { phone: string; wroteUser: boolean; lastAt: number; lastRole: string | null }> = {}
  for (const h of history) {
    if (!h.contact_phone) continue
    const k = key9(h.contact_phone)
    if (!byContact[k]) byContact[k] = { phone: h.contact_phone, wroteUser: false, lastAt: 0, lastRole: null }
    const c = byContact[k]
    if (h.role === 'user') c.wroteUser = true
    const t = new Date(h.created_at).getTime()
    if (t >= c.lastAt) { c.lastAt = t; c.lastRole = h.role ?? null }
  }
  const rows: Array<{ name: string; phone: string; lastAt: string; reason: string; returning: boolean }> = []
  for (const k in byContact) {
    const c = byContact[k]
    if (!c.wroteUser) continue            // solo quien realmente escribió
    if (boughtInPeriod.has(k)) continue   // compró en el período → no es perdido
    const reason = (c.lastRole === 'assistant' || c.lastRole === 'owner') ? 'No respondió' : 'Sin clasificar'
    rows.push({
      name: sessName[k] || c.phone,
      phone: c.phone,
      lastAt: new Date(c.lastAt).toISOString(),
      reason,
      returning: boughtEver.has(k)        // 🔁 ya fue cliente
    })
  }
  rows.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())   // más recientes primero (accionable)
  const noRespondio = rows.filter(r => r.reason === 'No respondió').length
  const returning   = rows.filter(r => r.returning).length
  return { label, count: rows.length, noRespondio, returning, nuevos: rows.length - returning, rows: rows.slice(0, limit) }
}

// Directorio de clientes (agrega ventas + sesiones por teléfono). Solo lectura.
const INACTIVE_DAYS = 60
interface CustomerDirectoryRow {
  name: string
  phone: string
  orders: number
  total: number
  lastPurchase: string
  daysSince: number
  status: 'nuevo' | 'frecuente' | 'activo' | 'inactivo'
}

async function getCustomerDirectory(bizId: string): Promise<CustomerDirectoryRow[]> {
  const [sales, sessions] = await Promise.all([db.getCustomerSales(bizId), db.getSessions(bizId)])
  const sessName: Record<string, string> = {}
  for (const s of sessions) if (s.contact_phone && s.contact_name) sessName[key9(s.contact_phone)] = s.contact_name
  const map: Record<string, { phone: string; name: string; orders: number; total: number; last: number | null; first: number | null }> = {}
  for (const v of sales) {
    const ph = v.contact_phone
    if (!ph) continue
    const customerKey = key9(ph)
    if (!customerKey) continue
    if (!map[customerKey]) map[customerKey] = { phone: ph, name: v.contact_name || sessName[customerKey] || ph, orders: 0, total: 0, last: null, first: null }
    const c = map[customerKey]
    c.orders += 1
    c.total += loDelLocal(v)
    const t = new Date(v.sold_at).getTime()
    if (c.last === null || t > c.last) c.last = t
    if (c.first === null || t < c.first) c.first = t
    if ((!c.name || c.name === ph) && (v.contact_name || sessName[key9(ph)])) c.name = v.contact_name || sessName[key9(ph)]
  }
  const now = Date.now(), DAY = 86400000
  return Object.values(map).map(c => {
    const last = c.last ?? 0
    const first = c.first ?? 0
    const daysSince = Math.floor((now - last) / DAY)
    let status: CustomerDirectoryRow['status']
    if (daysSince > INACTIVE_DAYS)                            status = 'inactivo'
    else if (c.orders >= 3)                                   status = 'frecuente'
    else if (c.orders === 1 && (now - first) / DAY <= 30)    status = 'nuevo'
    else                                                      status = 'activo'
    // El nombre editado en Conversaciones (sesión) manda sobre el de la venta
    return { name: sessName[key9(c.phone)] || c.name, phone: c.phone, orders: c.orders, total: c.total, lastPurchase: new Date(last).toISOString(), daysSince, status }
  }).sort((a, b) => b.total - a.total)
}

// Contactos que hace >= days días no nos escriben (para reactivar). Cruza con ventas
// para marcar si ya compraron (cliente) o solo consultaron (nunca compró). Solo lectura.
async function getInactiveContacts(bizId: string, days = 15) {
  const [sessions, sales] = await Promise.all([db.getSessions(bizId), db.getCustomerSales(bizId)])
  const buy: Record<string, { orders: number; total: number }> = {}
  for (const v of sales) {
    const ph = v.contact_phone
    if (!ph) continue
    const customerKey = key9(ph)
    if (!customerKey) continue
    if (!buy[customerKey]) buy[customerKey] = { orders: 0, total: 0 }
    buy[customerKey].orders += 1
    buy[customerKey].total += loDelLocal(v)
  }
  const now = Date.now(), DAY = 86400000
  const rows: Array<{
    name: string; phone: string; daysSince: number; lastMessageAt: string
    lastMessage: string; hasPurchased: boolean; orders: number; total: number
  }> = []
  for (const s of sessions) {
    const ph = s.contact_phone
    if (!ph || !s.last_message_at) continue
    const daysSince = Math.floor((now - new Date(s.last_message_at).getTime()) / DAY)
    if (daysSince < days) continue
    const b = buy[key9(ph)]
    rows.push({
      name: s.contact_name || ph,
      phone: ph,
      daysSince,
      lastMessageAt: s.last_message_at,
      lastMessage: (s.last_message || '').slice(0, 140),
      hasPurchased: !!b,
      orders: b ? b.orders : 0,
      total: b ? b.total : 0
    })
  }
  return rows.sort((a, b) => b.daysSince - a.daysSince)
}

// Resumen de la cartera de clientes (foto general, all-time) — para WhatsApp.
// Reutiliza el directorio (que ya calcula estado, total y días sin comprar).
async function computeCustomerSummary(bizId: string) {
  const dir = await getCustomerDirectory(bizId)   // ya viene ordenado por total desc
  const count = (st: CustomerDirectoryRow['status']) => dir.filter(c => c.status === st).length
  const top = dir.slice(0, 3).map(c => ({ name: c.name, total: c.total, orders: c.orders }))
  const inact = dir.filter(c => c.status === 'inactivo').sort((a, b) => b.daysSince - a.daysSince)
  return {
    total: dir.length,
    nuevos: count('nuevo'), frecuentes: count('frecuente'),
    activos: count('activo'), inactivos: count('inactivo'),
    top,
    riesgo: { count: inact.length, rows: inact.slice(0, 3).map(c => ({ name: c.name, daysSince: c.daysSince })) }
  }
}

// Tendencia de ventas por día (línea). Rellena días sin ventas con 0 → línea continua.
// Ventana: mes = 30 días, hoy/semana = 7 días (una línea de 1 punto no sirve).
async function computeSalesTrend(bizId: string, period?: ReportPeriod | null) {
  const days = period === 'mes' ? 30 : 7
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1))
  const sales = await db.getSalesWithItems(bizId, start.toISOString())
  const key = (d: string | Date) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
  const map: Record<string, { total: number; orders: number }> = {}
  for (const s of sales) {
    const k = key(s.sold_at)
    if (!map[k]) map[k] = { total: 0, orders: 0 }
    map[k].total += loDelLocal(s); map[k].orders++
  }
  const rows: Array<{ date: string; label: string; total: number; orders: number }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i)
    const k = key(d)
    rows.push({ date: k, label: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`, total: map[k]?.total || 0, orders: map[k]?.orders || 0 })
  }
  return { days, rows, total: rows.reduce((s, r) => s + r.total, 0) }
}

// ── Dashboard (resumen del negocio con datos para gráficos) ──
async function getDashboard(bizId: string, period: ReportPeriod) {
  const [summary, comp, top, cust, products, trend] = await Promise.all([
    computeSummary(bizId, period),
    computeComparison(bizId, period),
    computeTop(bizId, period, 6),
    computeCustomerSummary(bizId),
    db.getProducts(bizId),
    computeSalesTrend(bizId, period)
  ])
  const stock = { disponible: 0, ultimas: 0, agotado: 0 }
  for (const p of products) {
    if (p.stock === 'agotado') stock.agotado++
    else if (p.stock === 'últimas unidades') stock.ultimas++
    else stock.disponible++
  }
  return {
    period, label: summary.label,
    kpis: {
      total: summary.total, orders: summary.orders, avg: summary.avg,
      conversion: summary.conversion, items: summary.items,
      clientes: cust.total, nuevos: summary.nuevos, recurrentes: summary.recurrentes
    },
    comparison: { curTotal: comp.curTotal, prevTotal: comp.prevTotal, pct: comp.pct },
    trend,
    top: top.rows,
    customersByStatus: { nuevos: cust.nuevos, frecuentes: cust.frecuentes, activos: cust.activos, inactivos: cust.inactivos },
    stock
  }
}

// ── Alertas (Fase 1: banner en el panel) ──────────────────
// Vigila condiciones con los cálculos que ya existen y devuelve avisos
// ordenados por severidad. Solo lectura, sin push (eso es Fase 2).
async function computeAlerts(bizId: string) {
  const [lowStock, pending, comp, cust, today] = await Promise.all([
    db.getLowStockProducts(bizId),
    db.getPendingOrders(bizId),
    computeComparison(bizId, 'semana'),
    computeCustomerSummary(bizId),
    computeSummary(bizId, 'hoy'),
  ])
  type AlertLevel = 'critical' | 'warning' | 'info' | 'good'
  const alerts: Array<{ level: AlertLevel; icon: string; text: string }> = []
  const agotados = lowStock.filter(p => p.stock === 'agotado').length
  const ultimas  = lowStock.filter(p => p.stock === 'últimas unidades').length
  if (agotados) alerts.push({ level: 'critical', icon: '🔴', text: `${agotados} producto(s) agotado(s)` })
  if (ultimas)  alerts.push({ level: 'warning',  icon: '🟡', text: `${ultimas} producto(s) en últimas unidades` })
  if (pending.length) alerts.push({ level: 'warning', icon: '📋', text: `${pending.length} conversación(es) sin cerrar` })
  if (comp.pct !== null && comp.pct <= -20) alerts.push({ level: 'warning', icon: '📉', text: `Ventas ${comp.pct.toFixed(0)}% vs semana pasada` })
  if (comp.pct !== null && comp.pct >= 20)  alerts.push({ level: 'good',    icon: '📈', text: `Ventas +${comp.pct.toFixed(0)}% vs semana pasada` })
  if (cust.riesgo.count)     alerts.push({ level: 'info', icon: '😴', text: `${cust.riesgo.count} cliente(s) en riesgo (reactivar)` })
  if (new Date().getHours() >= 14 && today.orders === 0)
    alerts.push({ level: 'info', icon: '🌙', text: 'Aún sin ventas registradas hoy' })
  const rank: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2, good: 3 }
  alerts.sort((a, b) => rank[a.level] - rank[b.level])
  return { count: alerts.length, alerts }
}

// Todos los reportes juntos (para el panel web)
async function getAllReports(bizId: string, period: ReportPeriod) {
  // Egress: las ventas del período se descargan UNA vez y se comparten entre
  // los cálculos (antes eran 8 lecturas idénticas de Supabase por carga).
  const sales = await db.getSalesWithItems(bizId, rangeFor(period).start)
  const [summary, trend, top, lowMovement, comparison, recurring, lowStock, pending, bySeller, lostCustomers, umbaniEmbudo, umbaniLlegadas] = await Promise.all([
    computeSummary(bizId, period, sales), computeSalesTrend(bizId, period), computeTop(bizId, period, 5, sales), computeLowMovement(bizId, period, 5, sales),
    computeComparison(bizId, period, sales), computeRecurring(bizId, period, 5, sales), computeLowStock(bizId), computePending(bizId),
    computeBySeller(bizId, period, sales),
    computeLostCustomers(bizId, period, 50, sales),
    // ⚠️ Lo nuevo, y lo único que habla del modelo de HOY: por dónde llega su
    // cliente desde el número de Umbani y hasta dónde llega. Reemplaza a las
    // cuatro tarjetas que se alimentaban de tablas muertas.
    db.getLocalFunnel(bizId, diasDe(period)).catch(() => []),
    db.getLocalArrivals(bizId, diasDe(period)).catch(() => []),
  ])
  return { period, summary, trend, top, lowMovement, comparison, recurring, lowStock, pending, bySeller, lostCustomers, umbani: { embudo: umbaniEmbudo, llegadas: umbaniLlegadas } }
}

/** Los días que mira cada período, para las consultas que cuentan por días. */
const diasDe = (period?: ReportPeriod | null): number => (
  period === 'hoy' ? 1 : period === 'semana' ? 7 : 30
)

/**
 * Cómo llegan los clientes de este local desde el número de Umbani.
 *
 * ⚠️ Es el reporte que sustituye a los cuatro que se alimentaban de tablas
 * muertas. Lo cuenta la base por `business_id`: un local no ve los clientes de
 * otro, y hay una prueba de aislamiento que lo comprueba.
 */
async function computeUmbani(bizId: string, period?: ReportPeriod | null) {
  const dias = diasDe(period)
  const [embudo, llegadas] = await Promise.all([
    db.getLocalFunnel(bizId, dias).catch(() => []),
    db.getLocalArrivals(bizId, dias).catch(() => []),
  ])
  return { label: rangeFor(period).label, dias, embudo, llegadas }
}

// ══════════════════════════════════════════════════════════
// FORMATO WhatsApp — usan los mismos datos de cálculo
// ══════════════════════════════════════════════════════════

type SummaryReport = Awaited<ReturnType<typeof computeSummary>>
type SellerReport = Awaited<ReturnType<typeof computeBySeller>>
type TopReport = Awaited<ReturnType<typeof computeTop>>
type LowMovementReport = Awaited<ReturnType<typeof computeLowMovement>>
type ComparisonReport = Awaited<ReturnType<typeof computeComparison>>
type RecurringReport = Awaited<ReturnType<typeof computeRecurring>>
type LowStockReport = Awaited<ReturnType<typeof computeLowStock>>
type PendingReport = Awaited<ReturnType<typeof computePending>>
type LostCustomersReport = Awaited<ReturnType<typeof computeLostCustomers>>
type CustomerSummaryReport = Awaited<ReturnType<typeof computeCustomerSummary>>

const fmtSummary = (d: SummaryReport) => {
  // Pie: el reporte general trae lo global; desde aquí se pide cada detalle.
  const footer = '\n\n💡 También puedes pedirme por separado:\n'
    + '• "productos más vendidos" · "clientes frecuentes"\n'
    + '• "clientes perdidos" · "stock bajo" · "pedidos pendientes"'

  const salesBody = !d.orders
    ? 'Sin ventas registradas en el período. 🤷'
    : `💰 Tus ventas: ${money(d.total)}\n🧾 Pedidos: ${d.orders}\n📦 Ítems vendidos: ${d.items}\n🎟️ Ticket promedio: ${money(d.avg)}\n🆕 Clientes nuevos: ${d.nuevos}\n🔁 Clientes recurrentes: ${d.recurrentes}\n📈 Conversión: ${d.conversion === null ? 's/d' : d.conversion.toFixed(0) + '%'}`

  return `📊 Resumen de ventas (${d.label})\n\n${salesBody}${footer}`
}

const fmtBySeller = (d: SellerReport) => !d.rows.length
  ? `🧑‍💼 Ventas por vendedor (${d.label})\n\nSin ventas en el período.`
  : `🧑‍💼 Ventas por vendedor (${d.label})\n\n` +
    d.rows.map((r, i) => `${i + 1}. ${r.name} — ${r.orders} venta(s) · ${money(r.total)}`).join('\n')


const fmtTop = (d: TopReport) => !d.rows.length
  ? `🏆 Productos más vendidos (${d.label})\n\nSin ventas en el período.`
  : `🏆 Productos más vendidos (${d.label})\n\n` +
    d.rows.map((r, i) => `${['🥇','🥈','🥉'][i] || (i + 1) + '.'} ${r.name} — ${r.qty} uds · ${money(r.rev)}`).join('\n')

const fmtLowMovement = (d: LowMovementReport) => !d.rows.length
  ? `🐌 Productos de bajo movimiento (${d.label})\n\n¡Buenas noticias! Todos tus productos tuvieron ventas. 🎉`
  : `🐌 Productos de bajo movimiento (${d.label})\n(vendieron ${d.threshold === 0 ? 'nada' : d.threshold + ' o menos'} — candidatos a promoción)\n\n` +
    d.rows.map(p => `• ${p.name} — ${p.qty} uds`).join('\n')

const fmtComparison = (d: ComparisonReport) => {
  let trend
  if (d.pct === null) trend = d.curTotal > 0 ? '🚀 sin base anterior para comparar (período previo en 0)' : 'sin datos en ninguno de los dos períodos'
  else trend = (d.pct >= 0 ? '📈 +' : '📉 ') + d.pct.toFixed(1) + '%'
  return `📊 Comparación (${d.label} vs período anterior)\n\nActual: ${money(d.curTotal)} (${d.curOrders} pedidos)\nAnterior: ${money(d.prevTotal)} (${d.prevOrders} pedidos)\nVariación: ${trend}`
}

const fmtRecurring = (d: RecurringReport) => !d.rows.length
  ? `🤝 Clientes frecuentes (${d.label})\n\nSin ventas en el período.`
  : `🤝 Clientes frecuentes (${d.label})\n\n` +
    d.rows.map((r, i) => `${i + 1}. ${r.name} — ${r.orders} compra(s) · ${money(r.total)}`).join('\n')

const fmtLowStock = (d: LowStockReport) => !d.rows.length
  ? `📦 Inventario\n\nNingún producto marcado como agotado o en últimas unidades. ✅`
  : `📦 Productos con stock bajo o agotado\n\n` +
    d.rows.map(p => `${p.stock === 'agotado' ? '🔴' : '🟡'} ${p.name} — ${p.stock}`).join('\n')

const fmtPending = (d: PendingReport) => !d.count
  ? `📋 Pedidos pendientes\n\nNo hay cotizaciones sin cerrar. ✅`
  : `📋 Pedidos / cotizaciones sin cerrar (${d.count})\n(conversaciones que no terminaron en venta — para recuperar)\n\n` +
    d.rows.map(s => `• ${s.name}${s.last_message ? ' — "' + String(s.last_message).slice(0, 40) + '"' : ''}`).join('\n')

/**
 * ⚠️ Si nadie recibió su enlace, se dice ASÍ y no con un cero: un cero se lee
 * como «nadie me quiso», y lo cierto suele ser que el local está apagado o
 * recién creado.
 */
const fmtUmbani = (d: Awaited<ReturnType<typeof computeUmbani>>) => {
  const enlaces = d.embudo.find(p => p.orden === 1)?.clientes || 0
  if (!enlaces) {
    return `🧭 Cómo llegan tus clientes (${d.label})\n\n`
      + 'Todavía nadie recibió tu enlace en este período. '
      + 'Revisa que tu local esté visible en Umbani.'
  }
  const pasos = d.embudo
    .map(p => `• ${p.paso}: ${p.clientes}`)
    .join('\n')
  const puerta = d.llegadas.length
    ? `\n\n📍 Te encontraron en:\n`
      + d.llegadas.map(l => `• ${l.label} — ${l.veces}`).join('\n')
    : ''
  return `🧭 Cómo llegan tus clientes (${d.label})\n\n${pasos}${puerta}`
}

const fmtDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-EC', { day: '2-digit', month: 'short' }) }
const fmtLostCustomers = (d: LostCustomersReport) => !d.count
  ? `😟 Clientes perdidos (${d.label})\n\n¡Bien! No hay clientes que escribieran sin comprar en el período. 🎉`
  : `😟 Clientes perdidos (${d.label})\n(escribieron pero no compraron — para recuperar)\n\n` +
    `Total: ${d.count} · 🔁 ya fueron clientes: ${d.returning} · 🆕 nuevos: ${d.nuevos} · 🔕 no respondió: ${d.noRespondio}\n\n` +
    d.rows.slice(0, 15).map(r => `${r.returning ? '🔁' : '🆕'} ${r.name}${r.phone && r.name !== r.phone ? ' (' + r.phone + ')' : ''} — ${r.reason}${fmtDate(r.lastAt) ? ' · ' + fmtDate(r.lastAt) : ''}`).join('\n') +
    (d.count > 15 ? `\n\n…y ${d.count - 15} más. Míralos completos en el panel.` : '')

const fmtCustomerSummary = (d: CustomerSummaryReport) => !d.total
  ? `👥 Resumen de clientes\n\nAún no hay clientes con compras registradas.`
  : `👥 Resumen de clientes\n\n` +
    `Total: ${d.total} cliente(s)\n` +
    `🆕 Nuevos: ${d.nuevos}   🤝 Frecuentes: ${d.frecuentes}\n` +
    `🟢 Activos: ${d.activos}   😴 Inactivos: ${d.inactivos}\n\n` +
    `🏆 Tus mejores clientes:\n` +
    d.top.map((c, i) => `${['🥇','🥈','🥉'][i] || (i + 1) + '.'} ${c.name} — ${money(c.total)} · ${c.orders} compra(s)`).join('\n') +
    (d.riesgo.count
      ? `\n\n⚠️ ${d.riesgo.count} cliente(s) en riesgo (sin comprar +${INACTIVE_DAYS} días):\n` +
        d.riesgo.rows.map(c => `• ${c.name} (hace ${c.daysSince} días)`).join('\n') +
        (d.riesgo.count > d.riesgo.rows.length ? `\n…y ${d.riesgo.count - d.riesgo.rows.length} más. Reactívalos con una promo. 👉 Lista completa en el panel.` : '')
      : '')


async function runReport(biz: OwnerBusiness, intent: ReportIntent) {
  const bizId = biz.id
  const p = intent.period
  switch (intent.report) {
    case 'summary':      return fmtSummary(await computeSummary(bizId, p))
    case 'top':          return fmtTop(await computeTop(bizId, p))
    case 'low_movement': return fmtLowMovement(await computeLowMovement(bizId, p))
    case 'comparison':   return fmtComparison(await computeComparison(bizId, p))
    case 'recurring':    return fmtRecurring(await computeRecurring(bizId, p))
    case 'low_stock':    return fmtLowStock(await computeLowStock(bizId))
    case 'pending':      return fmtPending(await computePending(bizId))
    case 'seller':       return fmtBySeller(await computeBySeller(bizId, p))
    case 'lost':         return fmtLostCustomers(await computeLostCustomers(bizId, p))
    case 'customers':    return fmtCustomerSummary(await computeCustomerSummary(bizId))
    case 'umbani':       return fmtUmbani(await computeUmbani(bizId, p))
    default:             return null
  }
}

// ── Capa común WhatsApp: ¿es un reporte pedido por el dueño? ──
async function handleOwnerMessage(biz: OwnerBusiness, from: unknown, text: unknown) {
  if (!biz?.owner_phone || !samePhone(from, biz.owner_phone)) return { handled: false }
  const intent = detectReportIntent(text)
  // Es el DUEÑO pero no pidió un reporte claro: NO lo tratamos como cliente ni lo
  // derivamos a un humano. Se queda en "modo reportes" y recibe el menú de ayuda.
  if (!intent) {
    return { handled: true, reply: `📊 Soy tu asistente de reportes. Pídeme, por ejemplo:\n\n• "ventas de hoy / semana / mes"\n• "productos más vendidos"\n• "clientes frecuentes" · "clientes perdidos"\n• "stock bajo" · "pedidos pendientes"\n• "reporte de IA"\n\n(Para probar el bot como cliente, escríbele desde otro número 😉)` }
  }
  if (REPORTS_TIME_BOUND.includes(intent.report) && !intent.period) {
    return { handled: true, reply: '📅 ¿De qué período querés el reporte? Responde: *hoy*, *semana* o *mes*.' }
  }
  try {
    const reply = await runReport(biz, intent)
    return { handled: true, reply: reply || 'No pude generar ese reporte.' }
  } catch (e) {
    console.error('❌ reporte:', e instanceof Error ? e.message : e)
    return { handled: true, reply: 'Hubo un error generando el reporte. Intentá de nuevo.' }
  }
}

export { handleOwnerMessage, detectReportIntent, samePhone, getAllReports, getCustomerDirectory, getInactiveContacts, computeAlerts, getDashboard }
