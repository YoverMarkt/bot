import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  WEBHOOK_INBOX_ERROR_MAX_LENGTH,
  createWebhookInboxWorker,
  sanitizeWebhookInboxError,
} = require('../dist/services/webhook-inbox-worker')
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const workerSource = readFileSync(
  `${serverDir}/src/services/webhook-inbox-worker.ts`,
  'utf8',
)

const ok = data => ({ data, error: null })

function lease(index, provider = 'meta') {
  return {
    id: `event-${index}`,
    business_id: 'business-a',
    provider,
    payload: { index },
    lease_token: `lease-${index}`,
    attempts: 1,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function repository(overrides = {}) {
  return {
    leaseWebhookEvents: vi.fn(async () => ok([])),
    renewWebhookEventLease: vi.fn(async () => ok(true)),
    completeWebhookEvent: vi.fn(async () => ok(true)),
    failWebhookEvent: vi.fn(async () => ok('pending')),
    ...overrides,
  }
}

function manualScheduler() {
  let sequence = 0
  const jobs = new Map()
  return {
    scheduler: {
      setTimeout(callback, delay) {
        sequence += 1
        jobs.set(sequence, { callback, delay })
        return sequence
      },
      clearTimeout(handle) {
        jobs.delete(handle)
      },
    },
    runByDelay(delay) {
      const entry = [...jobs.entries()].find(([, job]) => job.delay === delay)
      if (!entry) throw new Error(`No existe un timer de ${delay} ms`)
      const [handle, job] = entry
      jobs.delete(handle)
      job.callback()
    },
    countByDelay(delay) {
      return [...jobs.values()].filter(job => job.delay === delay).length
    },
    size() {
      return jobs.size
    },
  }
}

describe('worker del inbox durable de webhooks', () => {
  it('no reserva más leases que su concurrencia y completa cada fila', async () => {
    const gate = deferred()
    const rows = Array.from({ length: 5 }, (_, index) => lease(index))
    const repo = repository({
      leaseWebhookEvents: vi.fn(async (_workerId, limit) => ok(rows.slice(0, limit))),
    })
    let active = 0
    let maximumActive = 0
    const worker = createWebhookInboxWorker({
      workerId: 'worker-concurrency',
      repository: repo,
      batchSize: 5,
      concurrency: 2,
      processEvent: vi.fn(async () => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await gate.promise
        active -= 1
      }),
    })

    const polling = worker.pollOnce()
    await vi.waitFor(() => expect(active).toBe(2))
    expect(worker.inFlightCount()).toBe(2)
    gate.resolve()

    await expect(polling).resolves.toBe(2)
    expect(maximumActive).toBe(2)
    expect(repo.leaseWebhookEvents)
      .toHaveBeenCalledWith('worker-concurrency', 2, 180)
    expect(repo.completeWebhookEvent).toHaveBeenCalledTimes(2)
    expect(repo.failWebhookEvent).not.toHaveBeenCalled()
    expect(worker.inFlightCount()).toBe(0)
  })

  it('reutiliza el mismo poll activo y nunca reserva dos lotes superpuestos', async () => {
    const reservation = deferred()
    const repo = repository({ leaseWebhookEvents: vi.fn(() => reservation.promise) })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-single-poll',
      repository: repo,
      processEvent: async () => {},
    })

    const first = worker.pollOnce()
    const second = worker.pollOnce()

    expect(second).toBe(first)
    expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1)
    reservation.resolve(ok([]))
    await expect(first).resolves.toBe(0)
  })

  it('registra fallos sanitizados y truncados sin completar el evento', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1, 'ycloud')])),
    })
    const reports = []
    const jwt = `${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
    const secret = 'super-secret-value'
    const worker = createWebhookInboxWorker({
      workerId: 'worker-failure',
      repository: repo,
      baseDelaySeconds: 20,
      processEvent: async () => {
        throw new Error(`token=${secret}\nBearer abc.def.ghi ${jwt} ${'x'.repeat(3_000)}`)
      },
      onError(error, context) {
        reports.push({ message: error.message, context })
      },
    })

    await expect(worker.pollOnce()).resolves.toBe(1)

    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
    expect(repo.failWebhookEvent).toHaveBeenCalledTimes(1)
    const [eventId, leaseToken, safeError, baseDelay] = (
      repo.failWebhookEvent.mock.calls[0]
    )
    expect([eventId, leaseToken, baseDelay]).toEqual(['event-1', 'lease-1', 20])
    expect(safeError.length).toBeLessThanOrEqual(WEBHOOK_INBOX_ERROR_MAX_LENGTH)
    expect(safeError).not.toContain(secret)
    expect(safeError).not.toContain(jwt)
    expect(safeError).not.toContain('\n')
    expect(reports.some(report => report.context.phase === 'process')).toBe(true)
  })

  it('trata fail=stale como lease perdido sin intentar ningún ACK adicional', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(7)])),
      failWebhookEvent: vi.fn(async () => ok('stale')),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-stale-failure',
      repository: repo,
      processEvent: async () => {
        throw new Error('fallo esperado')
      },
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    await expect(worker.pollOnce()).resolves.toBe(1)

    expect(repo.failWebhookEvent).toHaveBeenCalledTimes(1)
    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
    expect(reports.some(report => report.context.phase === 'fail')).toBe(true)
  })

  it('emite una señal explícita cuando un evento llega a dead-letter', async () => {
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(8)])),
      failWebhookEvent: vi.fn(async () => ok('dead')),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-dead-letter',
      repository: repo,
      processEvent: async () => { throw new Error('proveedor no disponible') },
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    await expect(worker.pollOnce()).resolves.toBe(1)
    expect(reports).toEqual(expect.arrayContaining([
      expect.objectContaining({ context: expect.objectContaining({ phase: 'dead' }) }),
    ]))
  })

  it('renueva leases largos y no confirma si el fencing indica pérdida', async () => {
    const processing = deferred()
    const timers = manualScheduler()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(2)])),
      renewWebhookEventLease: vi.fn(async () => ok(false)),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-heartbeat',
      repository: repo,
      scheduler: timers.scheduler,
      heartbeatIntervalMilliseconds: 45_000,
      leaseSeconds: 180,
      processEvent: () => processing.promise,
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    const polling = worker.pollOnce()
    await vi.waitFor(() => expect(timers.countByDelay(45_000)).toBe(1))
    timers.runByDelay(45_000)
    await vi.waitFor(() => expect(repo.renewWebhookEventLease).toHaveBeenCalledTimes(1))
    processing.resolve()
    await expect(polling).resolves.toBe(1)

    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()
    expect(repo.failWebhookEvent).not.toHaveBeenCalled()
    expect(reports.some(report => report.context.phase === 'renew')).toBe(true)
  })

  it('espera un heartbeat activo antes de completar con el mismo token', async () => {
    const processing = deferred()
    const renewal = deferred()
    const timers = manualScheduler()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(3)])),
      renewWebhookEventLease: vi.fn(() => renewal.promise),
    })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-heartbeat-race',
      repository: repo,
      scheduler: timers.scheduler,
      heartbeatIntervalMilliseconds: 45_000,
      leaseSeconds: 180,
      processEvent: () => processing.promise,
    })

    const polling = worker.pollOnce()
    await vi.waitFor(() => expect(timers.countByDelay(45_000)).toBe(1))
    timers.runByDelay(45_000)
    await vi.waitFor(() => expect(repo.renewWebhookEventLease).toHaveBeenCalledTimes(1))
    processing.resolve()
    await Promise.resolve()
    expect(repo.completeWebhookEvent).not.toHaveBeenCalled()

    renewal.resolve(ok(true))
    await expect(polling).resolves.toBe(1)
    expect(repo.completeWebhookEvent).toHaveBeenCalledWith('event-3', 'lease-3')
  })

  it('start es idempotente y stop cancela nuevos polls mientras drena el activo', async () => {
    const reservation = deferred()
    const timers = manualScheduler()
    const repo = repository({ leaseWebhookEvents: vi.fn(() => reservation.promise) })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-lifecycle',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: async () => {},
    })

    worker.start()
    worker.start()
    expect(worker.isRunning()).toBe(true)
    expect(timers.countByDelay(0)).toBe(1)
    timers.runByDelay(0)
    await vi.waitFor(() => expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1))

    let stopped = false
    const stopping = worker.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(worker.isRunning()).toBe(false)

    reservation.resolve(ok([]))
    await stopping
    expect(stopped).toBe(true)
    expect(timers.size()).toBe(0)
    expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1)
  })

  it('propaga errores del lease al poll manual y los reporta en el ciclo automático', async () => {
    const timers = manualScheduler()
    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ({
        data: null,
        error: { message: 'PostgreSQL no disponible' },
      })),
    })
    const reports = []
    const worker = createWebhookInboxWorker({
      workerId: 'worker-rpc-error',
      repository: repo,
      scheduler: timers.scheduler,
      processEvent: async () => {},
      onError(error, context) {
        reports.push({ error, context })
      },
    })

    await expect(worker.pollOnce()).rejects.toThrow('PostgreSQL no disponible')
    worker.start()
    timers.runByDelay(0)
    await vi.waitFor(() => expect(reports.some(
      report => report.context.phase === 'poll',
    )).toBe(true))
    await worker.stop()
  })

  it('solo queda ready tras una operación SQL reciente y válida', async () => {
    const timers = manualScheduler()
    const repo = repository()
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    const worker = createWebhookInboxWorker({
      workerId: 'worker-readiness',
      repository: repo,
      scheduler: timers.scheduler,
      readinessTimeoutMilliseconds: 1_000,
      processEvent: async () => {},
    })

    expect(worker.isReady()).toBe(false)
    expect(worker.lastSuccessfulDatabaseOperationAt()).toBeNull()
    worker.start()
    expect(worker.isReady()).toBe(false)
    timers.runByDelay(0)
    await vi.waitFor(() => expect(repo.leaseWebhookEvents).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(worker.isReady()).toBe(true))
    expect(worker.lastSuccessfulDatabaseOperationAt()).toBe(10_000)

    now.mockReturnValue(11_001)
    expect(worker.isReady()).toBe(false)
    await worker.stop()
    now.mockRestore()
  })

  it('rechaza opciones y leases inválidos antes de procesar', async () => {
    expect(() => createWebhookInboxWorker({
      workerId: '',
      processEvent: async () => {},
    })).toThrow('workerId')
    expect(() => createWebhookInboxWorker({
      workerId: 'w'.repeat(129),
      processEvent: async () => {},
    })).toThrow('entre 1 y 128')
    expect(() => createWebhookInboxWorker({
      workerId: 'worker-invalid-heartbeat',
      leaseSeconds: 30,
      heartbeatIntervalMilliseconds: 30_000,
      processEvent: async () => {},
    })).toThrow('heartbeatIntervalMilliseconds')

    const repo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([{ id: 'incompleto' }])),
    })
    const worker = createWebhookInboxWorker({
      workerId: 'worker-invalid-row',
      repository: repo,
      processEvent: async () => {},
    })
    await expect(worker.pollOnce()).rejects.toThrow('filas inválidas')

    const oversizedRepo = repository({
      leaseWebhookEvents: vi.fn(async () => ok([lease(1), lease(2)])),
    })
    const oversizedWorker = createWebhookInboxWorker({
      workerId: 'worker-too-many-rows',
      repository: oversizedRepo,
      batchSize: 5,
      concurrency: 1,
      processEvent: async () => {},
    })
    await expect(oversizedWorker.pollOnce()).rejects.toThrow('filas inválidas')
  })

  it('sanitiza valores no Error y no usa unref en ningún timer', () => {
    expect(sanitizeWebhookInboxError({ token: 'should-not-be-read' }))
      .toBe('Error interno durante el procesamiento del webhook')
    expect(workerSource).not.toContain('.unref(')
  })
})
