// @ts-check
// ── NÚCLEO DE DINERO ─────────────────────────────────────────────────
// Regla de oro del proyecto: la IA conversa, el CÓDIGO calcula.
// La IA solo emite ##PEDIDO:producto x cantidad; ...##. Este módulo:
//   1. parsea esa lista,
//   2. resuelve cada ítem contra el catálogo REAL (estricto: si hay duda, NO resuelve),
//   3. calcula subtotal/total en código (redondeo seguro a centavos),
//   4. arma el resumen oficial que envía el SERVIDOR (no la IA).
// Ningún monto que vea el cliente sale del modelo. Los descuentos solo
// existirán como regla de código/panel, jamás como decisión de la IA.

// Redondeo seguro a 2 decimales (evita errores de flotantes al sumar)
const money = v => Math.round((v + Number.EPSILON) * 100) / 100

// Normaliza para comparar nombres: minúsculas, sin tildes, espacios simples
const norm = s => (s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').trim()

// "Pizza Familiar x2; Coca Cola 1L" → [{ name:'Pizza Familiar', qty:2 }, { name:'Coca Cola 1L', qty:1 }]
// Acepta "x2" al final, "2x" al inicio, o sin cantidad (=1). Cantidad 1..99.
function parseItems(payload) {
  return String(payload || '')
    .split(/[;,\n]/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      let name = part, qty = 1
      const suf = part.match(/^(.+?)\s*[xX]\s*(\d{1,2})$/)      // "Pizza x2"
      const pre = part.match(/^(\d{1,2})\s*[xX]\s+(.+)$/)        // "2x Pizza"
      if (suf) { name = suf[1].trim(); qty = parseInt(suf[2]) }
      else if (pre) { qty = parseInt(pre[1]); name = pre[2].trim() }
      qty = Math.min(Math.max(qty || 1, 1), 99)
      return { name, qty }
    })
    .filter(i => i.name.length > 1)
}

// Resuelve cada ítem contra el catálogo del negocio. ESTRICTO por diseño:
//  1) nombre exacto (normalizado) → resuelve
//  2) coincidencia parcial con UN ÚNICO candidato → resuelve
//  3) ambiguo, desconocido o SIN PRECIO (> $0) → va a `unresolved`
// Con dinero no se adivina: un solo ítem sin resolver anula el total oficial.
function resolveItems(parsed, products) {
  const resolved = [], unresolved = []
  const active = (products || []).filter(p => p && p.name)
  for (const it of parsed) {
    const q = norm(it.name)
    let match = active.find(p => norm(p.name) === q)
    if (!match) {
      const cands = active.filter(p => norm(p.name).includes(q) || q.includes(norm(p.name)))
      if (cands.length === 1) match = cands[0]
    }
    if (!match) { unresolved.push(it.name); continue }
    const unit = parseFloat(match.price_sale) > 0 ? parseFloat(match.price_sale) : parseFloat(match.price)
    if (!(unit > 0)) { unresolved.push(`${match.name} (sin precio cargado)`); continue }
    resolved.push({ product: match, qty: it.qty, unit: money(unit) })
  }
  return { resolved, unresolved }
}

// Calcula ítems + totales EN CÓDIGO. El precio unitario queda congelado
// al momento del pedido (si luego cambia el catálogo, el pedido no se altera).
function computeOrder(resolved) {
  const items = resolved.map(r => ({
    product_id:   r.product.id,
    product_name: r.product.name,
    quantity:     r.qty,
    unit_price:   r.unit,
    line_total:   money(r.unit * r.qty)
  }))
  const subtotal = money(items.reduce((s, i) => s + i.line_total, 0))
  const discount = 0   // futuro: reglas de descuento por código/panel (nunca la IA)
  return { items, subtotal, discount, total: money(subtotal - discount) }
}

// Resumen OFICIAL del pedido — lo envía el servidor, con formato WhatsApp.
// Si hay link de pago (pasarela conectada), se incluye; si no, se coordina.
function buildSummary(order, payLink = null) {
  const f = v => `$${v.toFixed(2)}`
  const lines = order.items.map(i => i.quantity > 1
    ? `• ${i.quantity} x ${i.product_name} — ${f(i.unit_price)} c/u = ${f(i.line_total)}`
    : `• 1 x ${i.product_name} — ${f(i.unit_price)}`
  )
  let msg = `🧾 *Resumen de su pedido*\n${lines.join('\n')}\n———————————\n💰 *Total: ${f(order.total)}*`
  if (order.discount > 0) msg += `\n(incluye descuento de ${f(order.discount)})`
  msg += payLink
    ? `\n\n👉 Pague de forma segura aquí:\n${payLink}`
    : `\n\nEn breve coordinaremos con usted el pago y la entrega ✅`
  return msg
}

module.exports = { money, parseItems, resolveItems, computeOrder, buildSummary }
