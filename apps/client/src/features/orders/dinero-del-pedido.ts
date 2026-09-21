// ═══════════════════════════════════════════════════════════════════════════
// EL DESGLOSE QUE LE FALTABA A LA TARJETA DEL PEDIDO
// ═══════════════════════════════════════════════════════════════════════════
//
// Caso REAL, visto por el dueño en la pantalla de Pedidos el 2026-09-20:
//
//     1× Burger Pack                                              $10.99
//     Subtotal $10.99   Envío $2.00   Total $14.09
//
// $10.99 + $2.00 son $12.99, no $14.09. **Faltaban $1.10 sin explicar** en la
// pantalla que el dueño mira a diario para cotejar comprobantes. No era un
// error de cálculo —el dinero estaba bien repartido— sino que el margen de la
// plataforma no se pintaba en ninguna parte.
//
// El importe YA venía en la respuesta desde siempre: el repositorio pide
// `select('*')` y `orders.platform_markup` viaja con el resto. Solo no estaba
// declarado en el tipo ni dibujado.
//
// ── DOS REGLAS QUE NO SE NEGOCIAN ──────────────────────────────────────────
//
// 1. **El TOTAL sigue siendo el del CLIENTE.** Es lo que se transfiere y
//    contra lo que se compara el comprobante: cambiarlo por lo que recibe el
//    local rompería la validación de comprobantes. Lo que se añade es de dónde
//    sale el margen y cuánto queda, nunca en lugar del total.
//
// 2. **Esto es del panel del DUEÑO.** Al cliente no se le enseña el desglose:
//    paga su total con el margen ya dentro del precio (decisión del dueño,
//    2026-09-20).

/** Lo que hace falta del pedido para repartir su dinero. */
export interface DineroDelPedido {
  subtotal?: number | string | null
  total?: number | string | null
  platform_markup?: number | string | null
  merchant_subtotal?: number | string | null
  status?: string | null
}

/**
 * Los estados en los que el pedido MURIÓ sin que se moviera un centavo.
 *
 * ⚠️ Esto es lo que hace que la tarjeta CUADRE CON FINANZAS, y no es un detalle
 * de redacción. `platform_markup_summary` —lo que alimenta la comisión del mes
 * y la tarjeta de Finanzas— suma solo ventas `completada`, y una venta nace al
 * ENTREGAR. Un pedido expirado, cancelado o rechazado nunca llega a `sales`:
 * la plataforma NO le factura ese servicio y el local NO recibe nada.
 *
 * Sin esta distinción la tarjeta afirmaba «Servicio $1.20 · Recibes $13.98»
 * sobre un pedido EXPIRADO —el caso que lo destapó, 2026-09-20— y sumar los
 * servicios que se ven en pantalla nunca daba el número de Finanzas.
 */
const SIN_COBRO = ['cancelado', 'rechazado', 'expirado']

/**
 * Si este pedido mueve dinero de verdad.
 *
 * Los que siguen vivos todavía no están en Finanzas pero llegarán si se
 * entregan; los muertos no llegarán nunca.
 */
export const elPedidoSeCobra = (status?: string | null): boolean =>
  !SIN_COBRO.includes(String(status || '').trim())

export interface DesgloseDelPedido {
  /** Lo que se queda la plataforma. 0 = no hay nada que enseñar. */
  servicio: number
  /** Lo que de verdad le entra al local por este pedido. */
  recibeElLocal: number
  /**
   * Si el servicio se SUMÓ al cliente (`on_top`) o se le DESCONTÓ al comercio
   * (`absorbed`). Decide el signo con que se pinta.
   */
  servicioVaEncima: boolean
}

const numero = (valor: unknown): number => {
  const n = Number(valor ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Reparte el dinero de un pedido entre la plataforma y el local.
 *
 * ⚠️ `recibeElLocal` se calcula restando del TOTAL, no sumando al subtotal, y
 * eso vale para los dos modos de margen: con `on_top` el servicio se le sumó al
 * cliente y con `absorbed` se le descontó al comercio, pero en ambos casos lo
 * que recibe el local es el total menos el servicio.
 *
 * ⚠️ Con `absorbed` el margen ya está DENTRO del subtotal, así que pintarlo
 * como una línea más que se suma dejaría la cuenta cuadrando al revés. Se
 * distingue mirando si al comercio le quedó su precio entero o recortado.
 */
export const desgloseDelPedido = (pedido: DineroDelPedido): DesgloseDelPedido => {
  const servicio = numero(pedido.platform_markup)
  const total = numero(pedido.total)
  return {
    servicio,
    recibeElLocal: Math.round((total - servicio) * 100) / 100,
    servicioVaEncima: pedido.merchant_subtotal == null
      || numero(pedido.merchant_subtotal) >= numero(pedido.subtotal),
  }
}
