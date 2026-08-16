/**
 * La intención «sin IA, atiende por la app» durante un deploy code-first.
 *
 * `menu` solo puede llegar desde una fila legacy mientras la fase 3 aún no se
 * aplicó. Tratarlo aquí como miniapp evita que cada entrada de canal tenga una
 * ventana distinta donde todavía pague modelo o procesamiento de media.
 */
export const usaFlujoMiniapp = (chatMode?: string | null): boolean => (
  chatMode === 'miniapp' || chatMode === 'menu'
)
