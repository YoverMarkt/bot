/**
 * Los modos donde el modelo NUNCA se ejecuta.
 *
 * `miniapp` corta antes de la IA y manda el enlace; `menu` conduce la
 * conversación con opciones armadas por código. En los dos, una foto o una
 * nota de voz acabarían como texto que nadie va a interpretar, así que bajar
 * la media, transcribirla o pasarla por visión es dinero tirado — y son las
 * llamadas más caras del sistema.
 *
 * Vive aparte para que cada entrada de canal (WhatsApp, Telegram, el buzón de
 * comprobantes) no se invente su propia versión de la misma pregunta.
 */
export const atiendeSinIA = (chatMode?: string | null): boolean => (
  chatMode === 'miniapp' || chatMode === 'menu'
)
