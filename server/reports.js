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
const REPORTS_TIME_BOUND = ['summary', 'top', 'low_movement', 'comparison', 'recurring', 'seller', 'most_consulted', 'abandoned', 'lost']
function detectReportIntent(text) {
  const t = (text || '').toLowerCase()
  const has = (...ws) => ws.some(w => t.includes(w))
  let report = null
  if      (has('abandonad', 'consultado sin', 'interés sin', 'interes sin', 'preguntan pero no compran', 'no se cerr')) report = 'abandoned'
  else if (has('más consultad', 'mas consultad', 'más preguntad', 'mas preguntad', 'consultado', 'preguntan por', 'más interesados', 'mas interesados')) report = 'most_consulted'
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
    db.getSalesWithItems(bizId, start),
    db.getSaleCustomers(bizId),
    db.getWritersInRange(bizId, start)
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
  const [sales, users] = await Promise.all([db.getSalesWithItems(bizId, start), db.getClientUsers(bizId)])
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
  const sales = await db.getSalesWithItems(bizId, start)
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
  const [sales, products] = await Promise.all([db.getSalesWithItems(bizId, start), db.getProducts(bizId)])
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
    db.getSalesWithItems(bizId, cur.start),
    db.getSalesWithItems(bizId, prev.start, prev.end)
  ])
  const sum = arr => arr.reduce((s, v) => s + Number(v.total || 0), 0)
  const curTotal = sum(curSales), prevTotal = sum(prevSales)
  const pct = prevTotal === 0 ? null : ((curTotal - prevTotal) / prevTotal) * 100
  return { label: cur.label, curTotal, curOrders: curSales.length, prevTotal, prevOrders: prevSales.length, pct }
}

async function computeRecurring(bizId, period, topN = 5) {
  const { start, end, label } = rangeFor(period)
  const sales = await db.getSalesWithItems(bizId, start)
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

async function computeMostConsulted(bizId, period, limit = 5) {
  const { start, end, label } = rangeFor(period)
  const rows = await db.getConsultationsInRange(bizId, start)
  const map = {}
  for (const r of rows) {
    if (!r.product_id) continue
    if (!map[r.product_id]) map[r.product_id] = { name: r.products?.name || 'Producto', count: 0 }
    map[r.product_id].count++
  }
  return { label, rows: Object.values(map).sort((a, b) => b.count - a.count).slice(0, limit) }
}

async function computeAbandoned(bizId, period, limit = 10) {
  const { start, end, label } = rangeFor(period)
  const [consult, sales] = await Promise.all([
    db.getConsultationsInRange(bizId, start),
    db.getSalesWithItems(bizId, start)
  ])
  const soldIds = new Set()
  for (const v of sales) for (const i of (v.sale_items || [])) if (i.product_id) soldIds.add(i.product_id)
  const map = {}
  for (const r of consult) {
    if (!r.product_id || soldIds.has(r.product_id)) continue
    if (!map[r.product_id]) map[r.product_id] = { name: r.products?.name || 'Producto', consultas: 0 }
    map[r.product_id].consultas++
  }
  return { label, rows: Object.values(map).sort((a, b) => b.consultas - a.consultas).slice(0, limit) }
}

// Clientes perdidos: escribieron en el período pero NO compraron en él.
// Razón automática "No respondió" cuando el negocio (assistant/owner) habló al final.
// Badge: 🔁 ya fue cliente (compró alguna vez) vs 🆕 nuevo (nunca compró).
const key9 = s => digits(s).slice(-9)   // clave flexible de teléfono (últimos 9 dígitos)
async function computeLostCustomers(bizId, period, limit = 50) {
  const { start, end, label } = rangeFor(period)
  const [history, periodSales, allBuyers, sessions] = await Promise.all([
    db.getHistoryInRange(bizId, start),
    db.getSalesWithItems(bizId, start),
    db.getSaleCustomers(bizId),
    db.getSessions(bizId)
  ])
  // Compradores del período (excluir) y de siempre (para el badge)
  const boughtInPeriod = new Set(periodSales.map(v => key9(v.contact_phone)).filter(Boolean))
  const boughtEver     = new Set(allBuyers.map(c => key9(c.contact_phone)).filter(Boolean))
  // Nombre por teléfono desde sesiones
  const sessName = {}
  for (const s of sessions) if (s.contact_phone && s.contact_name) sessName[key9(s.contact_phone)] = s.contact_name
  // Agrupar el historial por contacto
  const byContact = {}
  for (const h of history) {
    if (!h.contact_phone) continue
    const k = key9(h.contact_phone)
    if (!byContact[k]) byContact[k] = { phone: h.contact_phone, wroteUser: false, lastAt: 0, lastRole: null }
    const c = byContact[k]
    if (h.role === 'user') c.wroteUser = true
    const t = new Date(h.created_at).getTime()
    if (t >= c.lastAt) { c.lastAt = t; c.lastRole = h.role }
  }
  const rows = []
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
  rows.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt))   // más recientes primero (accionable)
  const noRespondio = rows.filter(r => r.reason === 'No respondió').length
  const returning   = rows.filter(r => r.returning).length
  return { label, count: rows.length, noRespondio, returning, nuevos: rows.length - returning, rows: rows.slice(0, limit) }
}

// Directorio de clientes (agrega ventas + sesiones por teléfono). Solo lectura.
const INACTIVE_DAYS = 60
async function getCustomerDirectory(bizId) {
  const [sales, sessions] = await Promise.all([db.getCustomerSales(bizId), db.getSessions(bizId)])
  const sessName = {}
  for (const s of sessions) if (s.contact_phone && s.contact_name) sessName[s.contact_phone] = s.contact_name
  const map = {}
  for (const v of sales) {
    const ph = v.contact_phone
    if (!ph) continue
    if (!map[ph]) map[ph] = { phone: ph, name: v.contact_name || sessName[ph] || ph, orders: 0, total: 0, last: null, first: null }
    const c = map[ph]
    c.orders += 1
    c.total += Number(v.total || 0)
    const t = new Date(v.sold_at).getTime()
    if (c.last === null || t > c.last) c.last = t
    if (c.first === null || t < c.first) c.first = t
    if ((!c.name || c.name === ph) && (v.contact_name || sessName[ph])) c.name = v.contact_name || sessName[ph]
  }
  const now = Date.now(), DAY = 86400000
  return Object.values(map).map(c => {
    const daysSince = Math.floor((now - c.last) / DAY)
    let status
    if (daysSince > INACTIVE_DAYS)                            status = 'inactivo'
    else if (c.orders >= 3)                                   status = 'frecuente'
    else if (c.orders === 1 && (now - c.first) / DAY <= 30)   status = 'nuevo'
    else                                                      status = 'activo'
    return { name: c.name, phone: c.phone, orders: c.orders, total: c.total, lastPurchase: new Date(c.last).toISOString(), daysSince, status }
  }).sort((a, b) => b.total - a.total)
}

// Resumen de la cartera de clientes (foto general, all-time) — para WhatsApp.
// Reutiliza el directorio (que ya calcula estado, total y días sin comprar).
async function computeCustomerSummary(bizId) {
  const dir = await getCustomerDirectory(bizId)   // ya viene ordenado por total desc
  const count = st => dir.filter(c => c.status === st).length
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

// Todos los reportes juntos (para el panel web)
async function getAllReports(bizId, period) {
  const [summary, top, lowMovement, comparison, recurring, lowStock, pending, bySeller, mostConsulted, abandoned, lostCustomers] = await Promise.all([
    computeSummary(bizId, period), computeTop(bizId, period), computeLowMovement(bizId, period),
    computeComparison(bizId, period), computeRecurring(bizId, period), computeLowStock(bizId), computePending(bizId),
    computeBySeller(bizId, period), computeMostConsulted(bizId, period), computeAbandoned(bizId, period),
    computeLostCustomers(bizId, period)
  ])
  return { period, summary, top, lowMovement, comparison, recurring, lowStock, pending, bySeller, mostConsulted, abandoned, lostCustomers }
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

const fmtMostConsulted = d => !d.rows.length
  ? `🔎 Productos más consultados (${d.label})\n\nSin consultas registradas en el período.`
  : `🔎 Productos más consultados (${d.label})\n\n` +
    d.rows.map((r, i) => `${['🥇','🥈','🥉'][i] || (i + 1) + '.'} ${r.name} — ${r.count} consulta(s)`).join('\n')

const fmtAbandoned = d => !d.rows.length
  ? `🛒 Productos abandonados (${d.label})\n\n¡Bien! Todo lo consultado tuvo ventas (o no hubo consultas).`
  : `🛒 Productos abandonados (${d.label})\n(consultados pero sin ventas — oportunidad de recuperar)\n\n` +
    d.rows.map(r => `• ${r.name} — ${r.consultas} consulta(s), 0 ventas`).join('\n')

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

const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('es-EC', { day: '2-digit', month: 'short' }) }
const fmtLostCustomers = d => !d.count
  ? `😟 Clientes perdidos (${d.label})\n\n¡Bien! No hay clientes que escribieran sin comprar en el período. 🎉`
  : `😟 Clientes perdidos (${d.label})\n(escribieron pero no compraron — para recuperar)\n\n` +
    `Total: ${d.count} · 🔁 ya fueron clientes: ${d.returning} · 🆕 nuevos: ${d.nuevos} · 🔕 no respondió: ${d.noRespondio}\n\n` +
    d.rows.slice(0, 15).map(r => `${r.returning ? '🔁' : '🆕'} ${r.name}${r.phone && r.name !== r.phone ? ' (' + r.phone + ')' : ''} — ${r.reason}${fmtDate(r.lastAt) ? ' · ' + fmtDate(r.lastAt) : ''}`).join('\n') +
    (d.count > 15 ? `\n\n…y ${d.count - 15} más. Míralos completos en el panel.` : '')

const fmtCustomerSummary = d => !d.total
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
    case 'most_consulted': return fmtMostConsulted(await computeMostConsulted(bizId, p))
    case 'abandoned':    return fmtAbandoned(await computeAbandoned(bizId, p))
    case 'lost':         return fmtLostCustomers(await computeLostCustomers(bizId, p))
    case 'customers':    return fmtCustomerSummary(await computeCustomerSummary(bizId))
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

module.exports = { handleOwnerMessage, detectReportIntent, samePhone, getAllReports, getCustomerDirectory }
