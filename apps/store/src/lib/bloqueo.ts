// Cuánto le queda a un bloqueo temporal.
//
// Vive aparte de la pantalla porque es la única parte con reglas: el resto de
// `Bloqueado.tsx` es maquetación. Aquí se puede probar sin montar React, que
// es como se prueba todo lo demás de esta app.
//
// ⚠️ Un bloqueo PERMANENTE —el del dueño— llega con `until` en nulo y no
// promete nada. Prometer una hora que no se cumple es peor que no decir hora:
// es exactamente cómo nació el fallo del número del 2026-08-23.

/**
 * «faltan 28 minutos» · «falta 1 minuto» · «faltan 2 horas».
 *
 * Devuelve `null` cuando no hay plazo (permanente) o cuando ya pasó — y ese
 * nulo es la señal de que toca ofrecer volver a entrar, no un caso de borde.
 */
export const cuantoFalta = (
  hasta: string | null,
  ahora: number = Date.now(),
): string | null => {
  if (!hasta) return null
  const restan = new Date(hasta).getTime() - ahora
  if (!Number.isFinite(restan) || restan <= 0) return null

  // Se redondea HACIA ARRIBA: decir «faltan 0 minutos» cuando quedan 20
  // segundos manda a la persona a intentarlo antes de tiempo, y se encuentra
  // la misma pantalla otra vez.
  const minutos = Math.ceil(restan / 60000)

  // ⚠️ A partir de una hora se dicen las DOS unidades («faltan 3 h 20 min») en
  // vez de redondear a horas, y no es un detalle de estilo. Redondear hacia
  // abajo manda a la persona a intentarlo hasta 59 minutos antes de tiempo;
  // hacia arriba la hace esperar hasta 59 de más y puede que no vuelva. Con
  // las dos unidades no hay que elegir cuál de los dos errores cometer.
  if (minutos >= 60) {
    const horas = Math.floor(minutos / 60)
    const sueltos = minutos % 60
    const enHoras = horas === 1 ? '1 hora' : `${horas} horas`
    return sueltos
      ? `faltan ${horas} h ${sueltos} min`
      : `${horas === 1 ? 'falta' : 'faltan'} ${enHoras}`
  }
  return minutos === 1 ? 'falta 1 minuto' : `faltan ${minutos} minutos`
}
