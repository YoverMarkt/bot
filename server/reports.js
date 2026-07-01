// ============================================================
// reports.js — Reportes de ventas para el DUEÑO del negocio.
// Dos superficies comparten la MISMA lógica de cálculo:
//   1) WhatsApp: handleOwnerMessage() → texto plano (valida owner_phone).
//   2) Panel web: getAllReports() → datos JSON para renderizar tablas/tarjetas.
// Todo filtrado por business_id (aislamiento multi-tenant).
// ============================================================
const db = require('./db')

const money = n => '$' + (Number(n) || 0).toFixed(2)

// ── Comparar teléfonos de forma flexible (últimos 9 dígitos) ──
const digits = s => String(s || '').replace(/\D/g, '')
function samePhone(a, b) {
  const x = digits(a), y = digits(b)
  if (!x || !y) return false
  const n = Math.min(x.length, y.length, 9)
  return n > 0 && x.slice(-n) === y.slice(-n)
}

// ── Rangos de fecha por período ───────────────────────────
function rangeFor(period) {
  const now = new Date()
  const start = new Date(now)
  let label
  if (period === 'hoy')        { start.setHours(0, 0, 0, 0);            label = 'hoy' }
  else if (period === 'semana'){ start.setDate(start.getDate() - 7);   label = 'esta semana' }
  else                         { start.setMonth(start.getMonth() - 1); label = 'este mes' }
  return { start: start.toISOString(), end: now.toISOString(), label }
}
function previousRange(period) {
  const { start, end } = rangeFor(period)
  const s = new Date(start).getTime(), e = new Date(end).getTime()
  const win = e - s
  return { start: new Date(s - win).toISOString(), end: new Date(s).toISOString() }
}

// ── Detección de intención del dueño (para WhatsApp) ──────
const REPORTS_TIME_BOUND = ['summary', 'top', 'low_movement', 'comparison', 'recurring', 'seller']
function detectReportIntent(text) {
  const t = (text || '').toLowerCase()
  const has = (...ws) => ws.some(w => t.includes(w))
  let report = null
  if      (has('vendedor', 'vendedores', 'por empleado', 'cada empleado', 'quién vendió', 'quien vendio')) report = 'seller'
  else if (has('comparar', 'comparación', 'comparacion', 'crecimiento', 'creció', 'crecio', ' vs ', 'versus')) report = 'comparison'
  else if (has('cliente frecuente', 'clientes frecuentes', 'mejores clientes', 'quién compra', 'quien compra', 'recurrente', 'fideliz')) report = 'recurring'
  else if (has('menos vendido', 'bajo movimiento', 'no se vende', 'se vende poco', 'poco movimiento', 'liquidar', 'para promoción', 'para promocion')) report = 'low_movement'
  else if (has('más vendido', 'mas vendido', 'top producto', 'productos top', 'mejor producto', 'qué se vende', 'que se vende')) report = 'top'
  else if (has('stock', 'inventario', 'agotad', 'sin existencia', 'por acabarse', 'por agotarse')) report = 'low_stock'
  else if (has('pendiente', 'cotización', 'cotizacion', 'cotizaciones', 'sin cerrar', 'no cerr', 'ventas perdidas', 'recuperar')) report = 'pending'
  else if (has('resumen', 'cuánto vendí', 'cuanto vendi', 'cuánto vendimos', 'cuanto vendimos', 'total vendido', 'ventas', 'reporte', 'ticket promedio')) report = 'summary'
  if (!report) return null
  let period = null
  if      (has('hoy', 'día de hoy', 'dia de hoy')) period = 'hoy'
  else if (has('semana', 'semanal'))                period = 'semana'
  else if (has('mes', 'mensual', 'este mes'))       period = 'mes'
  return { report, period }
}

// ══════════════════════════════════════════════════════════
// CÁLCULO — devuelven datos estructurados (fuente única)
// ══════════════════════════════════════════════════════════

async function computeSummary(bizId, period) {
  const { start, end, label } = rangeFor(period)
  const [sales, allCustomers, writers] = await Promise.all([
    db.getSalesWithItems(bizId, start, end),
    db.getSaleCustomers(bizId),
    db.getWritersInRange(bizId, start, end)
  ])
  const total = sales.reduce((s, v) => s + Number(v.total || 0), 0)
  const items = sales.reduce((s, v) => s + (v.sale_items || []).reduce((a, i) => a + Number(i.quantity || 0), 0), 0)

  // Compradores distintos del período
  const periodBuyers = new Set(sales.map(v => v.contact_phone).filter(Boolean))
  // Primera compra (histórica) de cada cliente → para "clientes nuevos"
  const firstBuy = {}
  for (const c of allCustomers) {
    if (!c.contact_phone) continue
    const t = new Date(c.sold_at).getTime()
    if (!(c.contact_phone in firstBuy) || t < firstBuy[c.contact_phone]) firstBuy[c.contact_phone] = t
  }
  const startT = new Date(start).getTime()
  let nuevos = 0
  for (const ph of periodBuyers) if ((firstBuy[ph] ?? 0) >= startT) nuevos++
  // Recurrentes (histórico): clientes con 2+ compras en total
  const countByCust = {}
  for (const c of allCustomers) if (c.contact_phone) countByCust[c.contact_phone] = (countByCust[c.contact_phone] || 0) + 1
  const recurrentes = Object.values(countByCust).filter(n => n >= 2).length
  // Conversión: compradores del período ÷ clientes que escribieron
  const conversion = writers > 0 ? Math.min(100, (periodBuyers.size / writers) * 100) : null

  return {
    label, orders: sales.length, total, items, avg: sales.length ? total / sales.length : 0,
    nuevos, recurrentes, conversion, buyers: periodBuyers.size, writers
  }
}

async function computeBySeller(bizId, period) {
  const { start, end, label } = rangeFor(period)
  const [sales, users] = await Promise.all([db.getSalesWithItems(bizId, start, end), db.getClientUsers(bizId)])
  const nameById = {}
  users.forEach(u => { nameById[u.id] = u.name || u.email })
  const map = {}
  for (const v of sales) {
    const key = v.created_by || 'sin_asignar'
    const name = v.created_by ? (nameById[v.created_by] || 'Usuario') : 'Sin asignar'
    if (!map[key]) map[key] = { name, orders: 0, total: 0 }
    map[key].orders += 1
    map[key].total += Number(v.total || 0)
  }
  return { label, rows: Object.values(map).sort((a, b) => b.total - a.total) }
}

async function computeTop(bizId, period, limit = 5) {
  const { start, end, label } = rangeFor(period)
  const sales = await db.getSalesWithItems(bizId, start, end)
  const map = {}
  for (const v of sales) for (const i of (v.sale_items || [])) {
    const k = i.product_name || 'Producto'
    if (!map[k]) map[k] = { name: k, qty: 0, rev: 0 }
    map[k].qty += Number(i.quantity || 0)
    map[k].rev += Number(i.line_total || 0)
  }
  return { label, rows: Object.values(map).sort((a, b) => b.qty - a.qty).slice(0, limit) }
}

async function computeLowMovement(bizId, period, threshold = 0) {
  const { start, end, label } = rangeFor(period)
  const [sales, products] = await Promise.all([db.getSalesWithItems(bizId, start, end), db.getProducts(bizId)])
  const sold = {}
  for (const v of sales) for (const i of (v.sale_items || [])) {
    const k = (i.product_name || '').toLowerCase()
    sold[k] = (sold[k] || 0) + Number(i.quantity || 0)
  }
  const rows = products
    .map(p => ({ name: p.name, qty: sold[(p.name || '').toLowerCase()] || 0 }))
    .filter(p => p.qty <= threshold).sort((a, b) => a.qty - b.qty).slice(0, 12)
  return { label, threshold, rows }
}

async function computeComparison(bizId, period) {
  const cur = rangeFor(period), prev = previousRange(period)
  const [curSales, prevSales] = await Promise.all([
    db.getSalesWithItems(bizId, cur.start, cur.end),
    db.getSalesWithItems(bizId, prev.start, prev.end)
  ])
  const sum = arr => arr.reduce((s, v) => s + Number(v.total || 0), 0)
  const curTotal = sum(curSales), prevTotal = sum(prevSales)
  const pct = prevTotal === 0 ? null : ((curTotal - prevTotal) / prevTotal) * 100
  return { label: cur.label, curTotal, curOrders: curSales.length, prevTotal, prevOrders: prevSales.length, pct }
}

async function computeRecurring(bizId, period, topN = 5) {
  const { start, end, label } = rangeFor(period)
  const sales = await db.getSalesWithItems(bizId, start, end)
  const map = {}
  for (const v of sales) {
    const k = v.contact_phone || 's/n'
    if (!map[k]) map[k] = { name: v.contact_name || v.contact_phone || 'Cliente', orders: 0, total: 0 }
    map[k].orders += 1
    map[k].total += Number(v.total || 0)
  }
  return { label, rows: Object.values(map).sort((a, b) => b.orders - a.orders).slice(0, topN) }
}

async function computeLowStock(bizId) {
  const list = await db.getLowStockProducts(bizId)
  return { rows: list.map(p => ({ name: p.name, stock: p.stock })) }
}

async function computePending(bizId) {
  const list = await db.getPendingOrders(bizId)
  return { count: list.length, rows: list.slice(0, 15).map(s => ({ name: s.contact_name || s.contact_phone, last_message: s.last_message || '' })) }
}

// Todos los reportes juntos (para el panel web)
async function getAllReports(bizId, period) {
  const [summary, top, lowMovement, comparison, recurring, lowStock, pending, bySeller] = await Promise.all([
    computeSummary(bizId, period), computeTop(bizId, period), computeLowMovement(bizId, period),
    computeComparison(bizId, period), computeRecurring(bizId, period), computeLowStock(bizId), computePending(bizId),
    computeBySeller(bizId, period)
  ])
  return { period, summary, top, lowMovement, comparison, recurring, lowStock, pending, bySeller }
}

// ══════════════════════════════════════════════════════════
// FORMATO WhatsApp — usan los mismos datos de cálculo
// ══════════════════════════════════════════════════════════

const fmtSummary = d => !d.orders
  ? `📊 Resumen de ventas (${d.label})\n\nSin ventas registradas en el período. 🤷`
  : `📊 Resumen de ventas (${d.label})\n\n💰 Total vendido: ${money(d.total)}\n🧾 Pedidos: ${d.orders}\n📦 Ítems vendidos: ${d.items}\n🎟️ Ticket promedio: ${money(d.avg)}\n🆕 Clientes nuevos: ${d.nuevos}\n🔁 Clientes recurrentes: ${d.recurrentes}\n📈 Conversión: ${d.conversion === null ? 's/d' : d.conversion.toFixed(0) + '%'}`

const fmtBySeller = d => !d.rows.length
  ? `🧑‍💼 Ventas por vendedor (${d.label})\n\nSin ventas en el período.`
  : `🧑‍💼 Ventas por vendedor (${d.label})\n\n` +
    d.rows.map((r, i) => `${i + 1}. ${r.name} — ${r.orders} venta(s) · ${money(r.total)}`).join('\n')

const fmtTop = d => !d.rows.length
  ? `🏆 Productos más vendidos (${d.label})\n\nSin ventas en el período.`
  : `🏆 Productos más vendidos (${d.label})\n\n` +
    d.rows.map((r, i) => `${['🥇','🥈','🥉'][i] || (i + 1) + '.'} ${r.name} — ${r.qty} uds · ${money(r.rev)}`).join('\n')

const fmtLowMovement = d => !d.rows.length
  ? `🐌 Productos de bajo movimiento (${d.label})\n\n¡Buenas noticias! Todos tus productos tuvieron ventas. 🎉`
  : `🐌 Productos de bajo movimiento (${d.label})\n(vendieron ${d.threshold === 0 ? 'nada' : d.threshold + ' o menos'} — candidatos a promoción)\n\n` +
    d.rows.map(p => `• ${p.name} — ${p.qty} uds`).join('\n')

const fmtComparison = d => {
  let trend
  if (d.pct === null) trend = d.curTotal > 0 ? '🚀 sin base anterior para comparar (período previo en 0)' : 'sin datos en ninguno de los dos períodos'
  else trend = (d.pct >= 0 ? '📈 +' : '📉 ') + d.pct.toFixed(1) + '%'
  return `📊 Comparación (${d.label} vs período anterior)\n\nActual: ${money(d.curTotal)} (${d.curOrders} pedidos)\nAnterior: ${money(d.prevTotal)} (${d.prevOrders} pedidos)\nVariación: ${trend}`
}

const fmtRecurring = d => !d.rows.length
  ? `🤝 Clientes frecuentes (${d.label})\n\nSin ventas en el período.`
  : `🤝 Clientes frecuentes (${d.label})\n\n` +
    d.rows.map((r, i) => `${i + 1}. ${r.name} — ${r.orders} compra(s) · ${money(r.total)}`).join('\n')

const fmtLowStock = d => !d.rows.length
  ? `📦 Inventario\n\nNingún producto marcado como agotado o en últimas unidades. ✅`
  : `📦 Productos con stock bajo o agotado\n\n` +
    d.rows.map(p => `${p.stock === 'agotado' ? '🔴' : '🟡'} ${p.name} — ${p.stock}`).join('\n')

const fmtPending = d => !d.count
  ? `📋 Pedidos pendientes\n\nNo hay cotizaciones sin cerrar. ✅`
  : `📋 Pedidos / cotizaciones sin cerrar (${d.count})\n(conversaciones que no terminaron en venta — para recuperar)\n\n` +
    d.rows.map(s => `• ${s.name}${s.last_message ? ' — "' + String(s.last_message).slice(0, 40) + '"' : ''}`).join('\n')

async function runReport(bizId, intent) {
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
    default:             return null
  }
}

// ── Capa común WhatsApp: ¿es un reporte pedido por el dueño? ──
async function handleOwnerMessage(biz, from, text) {
  if (!biz?.owner_phone || !samePhone(from, biz.owner_phone)) return { handled: false }
  const intent = detectReportIntent(text)
  if (!intent) return { handled: false }
  if (REPORTS_TIME_BOUND.includes(intent.report) && !intent.period) {
    return { handled: true, reply: '📅 ¿De qué período querés el reporte? Responde: *hoy*, *semana* o *mes*.' }
  }
  try {
    const reply = await runReport(biz.id, intent)
    return { handled: true, reply: reply || 'No pude generar ese reporte.' }
  } catch (e) {
    console.error('❌ reporte:', e.message)
    return { handled: true, reply: 'Hubo un error generando el reporte. Intentá de nuevo.' }
  }
}

module.exports = { handleOwnerMessage, detectReportIntent, samePhone, getAllReports }
