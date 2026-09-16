/**
 * ¿Este negocio se atiende sin que corra un modelo?
 *
 * Desde el 2026-09-16 solo hay un modo, `miniapp`: corta antes de la IA y
 * manda el enlace. Una foto o una nota de voz acabarían como texto que nadie
 * va a interpretar, así que bajar la media, transcribirla o pasarla por visión
 * es dinero tirado — y son las llamadas más caras del sistema.
 *
 * ⚠️ Se sigue PREGUNTANDO en vez de devolver `true` a secas para que la
 * pregunta siga atada a la columna. Ojo con el lado malo, que no es obvio: un
 * valor distinto devuelve `false`, y eso hace BAJAR la media —y transcribirla,
 * y pasarla por visión— para que después `bot-conversation` calle por modo no
 * reconocido. O sea, se paga por nada. Por eso el cerrojo de verdad es el
 * CHECK de un solo valor en PostgreSQL, no esta línea: aquí no puede llegar
 * otra cosa. Antes también valía `'menu'`, que conducía el pedido por chat.
 *
 * Vive aparte para que cada entrada de canal (WhatsApp, Telegram, el buzón de
 * comprobantes) no se invente su propia versión de la misma pregunta.
 */
export const atiendeSinIA = (chatMode?: string | null): boolean => (
  chatMode === 'miniapp'
)
