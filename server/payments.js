// @ts-check
// ── PASARELAS DE PAGO (abstracción enchufable) ───────────────────────
// El núcleo de dinero (money.js + orders) ya calcula el total oficial por
// código. Este módulo es el ÚNICO punto donde se conecta una pasarela.
//
// HOY: ninguna pasarela configurada → createPaymentLink devuelve null y el
// resumen oficial cierra con "coordinaremos el pago" (checkout por WhatsApp).
//
// MAÑANA (DeUna de Banco Pichincha u otra):
//   1. Credenciales POR NEGOCIO en BD (ej. columnas deuna_api_key/deuna_merchant
//      en businesses, como ya se hace con ycloud_*/meta_*) — el pago le llega
//      DIRECTO a la cuenta del negocio, nunca al dueño del SaaS. NUNCA hardcodear.
//   2. Implementar aquí createPaymentLink: llamar la API de la pasarela con el
//      monto de `order.total` (calculado server-side, jamás texto de la IA),
//      guardar payment_provider/payment_link/payment_ref en la orden.
//   3. Webhook de confirmación (en index.js): verificar FIRMA + anti-duplicado
//      (patrón ya existente), marcar orden 'pagado', registrar la venta y
//      avisar al dueño. El link debe expirar y atarse a UNA sola orden.

async function createPaymentLink(biz, order) {
  // Sin pasarela conectada todavía → sin link (el flujo sigue por coordinación).
  return null
}

module.exports = { createPaymentLink }
