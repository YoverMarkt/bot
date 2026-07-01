// ============================================================
// reports.js — Reportes de ventas para el DUEÑO del negocio (vía WhatsApp)
// - 7 reportes, todos filtrados por business_id (aislamiento multi-tenant).
// - Capa común: detecta la intención + valida que el número sea el dueño
//   ANTES de exponer cualquier dato. Si no es el dueño o no es un reporte,
//   devuelve { handled:false } y el bot sigue su flujo normal de atención.
// - Salida en texto plano para WhatsApp (sin markdown, emojis moderados, $ local).
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
// Ventana anterior del mismo tamaño (para comparación)
function previousRange(period) {
  const { start, end } = rangeFor(period)
  const s = new Date(start).getTime(), e = new Date(end).getTime()
  const win = e - s
  return { start: new Date(s - win).toISOString(), end: new Date(s).toISOString() }
}

// ── Detección de intención del dueño ──────────────────────
// Devuelve { report, period } o null si no parece un reporte.
const REPORTS_TIME_BOUND = ['summary', 'top', 'low_movement', 'comparison', 'recurring']
function detectReportIntent(text) {
  const t = (text || '').toLowerCase()
  const has = (...ws) => ws.some(w => t.includes(w))

  let report = null
  if      (has('comparar', 'comparación', 'comparacion', 'crecimiento', 'creció', 'crecio', ' vs ', 'versus')) report = 'comparison'
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

// ── Los 7 reportes ────────────────────────────────────────

async function salesSummary(bizId, period) {
  const { start, end, label } = rangeFor(period)
  const sales = await db.getSalesWithItems(bizId, start, end)
  if (!sales.length) return `📊 Resumen de ventas (${label})\n\nSin ventas registradas en el período. 🤷`
  const total = sales.reduce((s, v) => s + Number(v.total || 0), 0)
  const items = sales.reduce((s, v) => s + (v.sale_items || []).reduce((a, i) => a + Number(i.quantity || 0), 0), 0)
  const avg = total / sales.length
  return `📊 Resumen de ventas (${label})\n\n` +
    `💰 Total vendido: ${money(total)}\n` +
    `🧾 Pedidos: ${sales.length}\n` +
    `📦 Ítems vendidos: ${items}\n` +
    `🎟️ Ticket promedio: ${money(avg)}`
}

async function topProducts(bizId, period, limit = 5) {
  const { start, end, label } = rangeFor(period)
  const sales = await db.getSalesWithItems(bizId, start, end)
  const map = {}
  for (const v of sales) for (const i of (v.sale_items || [])) {
    const k = i.product_name || 'Producto'
    if (!map[k]) map[k] = { qty: 0, rev: 0 }
    map[k].qty += Number(i.quantity || 0)
    map[k].rev += Number(i.line_total || 0)
  }
  const rows = Object.entries(map).sort((a, b) => b[1].qty - a[1].qty).slice(0, limit)
  if (!rows.length) return `🏆 Productos más vendidos (${label})\n\nSin ventas en el período.`
  const medal = ['🥇', '🥈', '🥉']
  return `🏆 Productos más vendidos (${label})\n\n` +
    rows.map((r, idx) => `${medal[idx] || (idx + 1) + '.'} ${r[0]} — ${r[1].qty} uds · ${money(r[1].rev)}`).join('\n')
}

async function lowMovement(bizId, period, threshold = 0) {
  const { start, end, label } = rangeFor(period)
  const [sales, products] = await Promise.all([
    db.getSalesWithItems(bizId, start, end),
    db.getProducts(bizId)
  ])
  const sold = {}
  for (const v of sales) for (const i of (v.sale_items || [])) {
    const k = (i.product_name || '').toLowerCase()
    sold[k] = (sold[k] || 0) + Number(i.quantity || 0)
  }
  const low = products
    .map(p => ({ name: p.name, qty: sold[(p.name || '').toLowerCase()] || 0 }))
    .filter(p => p.qty <= threshold)
    .sort((a, b) => a.qty - b.qty)
    .slice(0, 12)
  if (!low.length) return `🐌 Productos de bajo movimiento (${label})\n\n¡Buenas noticias! Todos tus productos tuvieron ventas. 🎉`
  return `🐌 Productos de bajo movimiento (${label})\n` +
    `(vendieron ${threshold === 0 ? 'nada' : threshold + ' o menos'} — candidatos a promoción)\n\n` +
    low.map(p => `• ${p.name} — ${p.qty} uds`).join('\n')
}

async function periodComparison(bizId, period) {
  const cur = rangeFor(period)
  const prev = previousRange(period)
  const [curSales, prevSales] = await Promise.all([
    db.getSalesWithItems(bizId, cur.start, cur.end),
    db.getSalesWithItems(bizId, prev.start, prev.end)
  ])
  const sum = arr => arr.reduce((s, v) => s + Number(v.total || 0), 0)
  const curT = sum(curSales), prevT = sum(prevSales)
  let trend
  if (prevT === 0) trend = curT > 0 ? '🚀 sin base anterior para comparar (período previo en 0)' : 'sin datos en ninguno de los dos períodos'
  else {
    const pct = ((curT - prevT) / prevT) * 100
    trend = (pct >= 0 ? '📈 +' : '📉 ') + pct.toFixed(1) + '%'
  }
  return `📊 Comparación (${cur.label} vs período anterior)\n\n` +
    `Actual: ${money(curT)} (${curSales.length} pedidos)\n` +
    `Anterior: ${money(prevT)} (${prevSales.length} pedidos)\n` +
    `Variación: ${trend}`
}

async function recurringCustomers(bizId, period, topN = 5) {
  const { start, end, label } = rangeFor(period)
  const sales = await db.getSalesWithItems(bizId, start, end)
  const map = {}
  for (const v of sales) {
    const k = v.contact_phone || 's/n'
    if (!map[k]) map[k] = { name: v.contact_name || v.contact_phone || 'Cliente', orders: 0, total: 0 }
    map[k].orders += 1
    map[k].total += Number(v.total || 0)
  }
  const rows = Object.values(map).sort((a, b) => b.orders - a.orders).slice(0, topN)
  if (!rows.length) return `🤝 Clientes frecuentes (${label})\n\nSin ventas en el período.`
  return `🤝 Clientes frecuentes (${label})\n\n` +
    rows.map((r, i) => `${i + 1}. ${r.name} — ${r.orders} compra(s) · ${money(r.total)}`).join('\n')
}

async function lowStock(bizId) {
  const list = await db.getLowStockProducts(bizId)
  if (!list.length) return `📦 Inventario\n\nNingún producto marcado como agotado o en últimas unidades. ✅`
  return `📦 Productos con stock bajo o agotado\n\n` +
    list.map(p => `${p.stock === 'agotado' ? '🔴' : '🟡'} ${p.name} — ${p.stock}`).join('\n')
}

async function pendingOrders(bizId) {
  const list = await db.getPendingOrders(bizId)
  if (!list.length) return `📋 Pedidos pendientes\n\nNo hay cotizaciones sin cerrar. ✅`
  return `📋 Pedidos / cotizaciones sin cerrar (${list.length})\n` +
    `(conversaciones que no terminaron en venta — para recuperar)\n\n` +
    list.slice(0, 15).map(s => `• ${s.contact_name || s.contact_phone}${s.last_message ? ' — "' + String(s.last_message).slice(0, 40) + '"' : ''}`).join('\n')
}

// ── Ejecutor ──────────────────────────────────────────────
async function runReport(bizId, intent) {
  switch (intent.report) {
    case 'summary':      return salesSummary(bizId, intent.period)
    case 'top':          return topProducts(bizId, intent.period)
    case 'low_movement': return lowMovement(bizId, intent.period)
    case 'comparison':   return periodComparison(bizId, intent.period)
    case 'recurring':    return recurringCustomers(bizId, intent.period)
    case 'low_stock':    return lowStock(bizId)
    case 'pending':      return pendingOrders(bizId)
    default:             return null
  }
}

// ── Capa común: ¿este mensaje es un reporte pedido por el dueño? ──
// Devuelve { handled, reply? }. handled=false → el bot sigue su flujo normal.
async function handleOwnerMessage(biz, from, text) {
  // 1) Validar dueño: debe haber owner_phone configurado y coincidir con quien escribe
  if (!biz?.owner_phone || !samePhone(from, biz.owner_phone)) return { handled: false }
  // 2) Detectar intención de reporte
  const intent = detectReportIntent(text)
  if (!intent) return { handled: false }   // el dueño escribió otra cosa → flujo normal
  // 3) Período ambiguo en reportes que lo necesitan → preguntar antes de asumir
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

module.exports = { handleOwnerMessage, detectReportIntent, samePhone }
