import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  MAX_IN_FLIGHT_FLOW_METRICS,
  recordFlowMetricBestEffort,
} = require('../dist/services/whatsapp-flow-metrics')

describe('métricas best-effort de WhatsApp Flows', () => {
  it('absorbe errores síncronos y rechazos asíncronos', async () => {
    const synchronousFailure = vi.fn(() => {
      throw new Error('métrica síncrona no disponible')
    })
    const asynchronousFailure = vi.fn(async () => {
      throw new Error('métrica asíncrona no disponible')
    })

    expect(() => recordFlowMetricBestEffort(
      synchronousFailure,
      { eventType: 'step.sync' },
    )).not.toThrow()
    expect(() => recordFlowMetricBestEffort(
      asynchronousFailure,
      { eventType: 'step.async' },
    )).not.toThrow()

    await Promise.resolve()
    expect(synchronousFailure).toHaveBeenCalledOnce()
    expect(asynchronousFailure).toHaveBeenCalledOnce()
  })

  it('limita las escrituras activas cuando el backend queda colgado', () => {
    const neverSettles = vi.fn(() => new Promise(() => {}))

    for (let index = 0; index < MAX_IN_FLIGHT_FLOW_METRICS + 5; index += 1) {
      recordFlowMetricBestEffort(neverSettles, { index })
    }

    expect(neverSettles).toHaveBeenCalledTimes(MAX_IN_FLIGHT_FLOW_METRICS)
  })

  it('libera capacidad cuando una escritura termina', async () => {
    let release
    const recorder = vi.fn(() => new Promise(resolve => {
      release = resolve
    }))

    recordFlowMetricBestEffort(recorder, { eventType: 'first' })
    release(true)
    await Promise.resolve()
    await Promise.resolve()
    recordFlowMetricBestEffort(recorder, { eventType: 'second' })

    expect(recorder).toHaveBeenCalledTimes(2)
  })
})
