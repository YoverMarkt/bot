// Leer un monto escrito por una persona o impreso en un papel: «$1,234.56»,
// «USD 1.234,56», «3,50». Lo usan el lector de comprobantes y el de cartas.

/**
 * Normaliza un monto.
 *
 * ⚠️ No se usa `Number(...)` a secas: `Number(null)` es **0**, no NaN, y un
 * monto nulo pasaría como cero — el mismo fallo que ya cazaron `accuracy_m` y
 * la latitud de las ubicaciones. Aquí un cero colado sería peor: parecería un
 * comprobante de $0 que no cuadra con el pedido y dispararía una alarma falsa.
 */
export const normalizarMonto = (valor: unknown): string | null => {
  if (valor === null || valor === undefined) return null
  const crudo = String(valor).trim()
  if (!crudo) return null
  // Se queda con dígitos, puntos y comas: «USD 1.234,56» y «$1,234.56» son la
  // misma cifra escrita a los dos lados del continente.
  const limpio = crudo.replace(/[^\d.,-]/g, '')
  if (!limpio || !/\d/.test(limpio)) return null

  let normalizado = limpio
  const coma = limpio.lastIndexOf(',')
  const punto = limpio.lastIndexOf('.')
  if (coma > -1 && punto > -1) {
    // El último separador es el decimal; el otro son los miles.
    normalizado = coma > punto
      ? limpio.replace(/\./g, '').replace(',', '.')
      : limpio.replace(/,/g, '')
  } else if (coma > -1) {
    // Solo comas: decimal si deja dos dígitos detrás, miles si no.
    normalizado = /,\d{1,2}$/.test(limpio)
      ? limpio.replace(',', '.')
      : limpio.replace(/,/g, '')
  }

  const numero = Number.parseFloat(normalizado)
  if (!Number.isFinite(numero) || numero < 0 || numero > 999999) return null
  return numero.toFixed(2)
}
