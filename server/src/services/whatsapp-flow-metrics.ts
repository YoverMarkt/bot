export type FlowMetricRecorder<TInput> = (
  input: TInput,
) => Promise<unknown> | unknown

// Una métrica nunca justifica acumular solicitudes de base de datos sin límite.
// Si el backend de observabilidad se atasca, se conservan como máximo estas
// escrituras activas por recorder y las siguientes se descartan.
export const MAX_IN_FLIGHT_FLOW_METRICS = 8

const inFlightByRecorder = new WeakMap<object, number>()

/**
 * Inicia una escritura de observabilidad sin incorporarla a la ruta crítica.
 *
 * - Nunca devuelve ni espera la Promise del recorder.
 * - Absorbe tanto errores síncronos como rechazos asíncronos.
 * - Limita las escrituras simultáneas por recorder para que una dependencia
 *   colgada no acumule trabajo sin límite.
 *
 * Las mutaciones canónicas deben seguir esperándose antes de llamar esta
 * función; este helper es únicamente para métricas best-effort.
 */
export function recordFlowMetricBestEffort<TInput>(
  recorder: FlowMetricRecorder<TInput> | null | undefined,
  input: TInput,
): void {
  if (!recorder) return

  const active = inFlightByRecorder.get(recorder) || 0
  if (active >= MAX_IN_FLIGHT_FLOW_METRICS) return
  inFlightByRecorder.set(recorder, active + 1)

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    const current = inFlightByRecorder.get(recorder) || 0
    if (current <= 1) {
      inFlightByRecorder.delete(recorder)
      return
    }
    inFlightByRecorder.set(recorder, current - 1)
  }

  let pending: Promise<unknown>
  try {
    pending = Promise.resolve(recorder(input))
  } catch {
    release()
    return
  }

  // Los dos callbacks convierten cualquier resultado en una Promise resuelta;
  // así tampoco queda un rechazo no observado después de responder a YCloud.
  void pending.then(release, release)
}
