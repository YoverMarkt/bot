import {
  completeWebhookEvent,
  failWebhookEvent,
  leaseWebhookEvents,
  renewWebhookEventLease,
  type WebhookFailureStatus,
  type WebhookInboxLease,
  type WebhookRpcResponse,
} from '../db/repositories/webhook-events'

type TimerHandle = ReturnType<typeof setTimeout>

export const WEBHOOK_INBOX_ERROR_MAX_LENGTH = 2_000

export interface WebhookInboxRepository {
  leaseWebhookEvents(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Promise<WebhookRpcResponse<WebhookInboxLease[]>>
  renewWebhookEventLease(
    eventId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): Promise<WebhookRpcResponse<boolean>>
  completeWebhookEvent(
    eventId: string,
    leaseToken: string,
  ): Promise<WebhookRpcResponse<boolean>>
  failWebhookEvent(
    eventId: string,
    leaseToken: string,
    error: string,
    baseDelaySeconds: number,
  ): Promise<WebhookRpcResponse<WebhookFailureStatus>>
}

export interface WebhookInboxScheduler {
  setTimeout(callback: () => void, delayMilliseconds: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export type WebhookInboxWorkerPhase =
  | 'poll'
  | 'process'
  | 'renew'
  | 'complete'
  | 'fail'
  | 'dead'

export interface WebhookInboxWorkerErrorContext {
  phase: WebhookInboxWorkerPhase
  eventId?: string
  provider?: string
}

export interface WebhookInboxWorkerOptions {
  workerId: string
  processEvent(event: WebhookInboxLease): Promise<void>
  repository?: WebhookInboxRepository
  scheduler?: WebhookInboxScheduler
  onError?: (
    error: Error,
    context: WebhookInboxWorkerErrorContext,
  ) => void
  batchSize?: number
  concurrency?: number
  pollIntervalMilliseconds?: number
  leaseSeconds?: number
  heartbeatIntervalMilliseconds?: number
  baseDelaySeconds?: number
  readinessTimeoutMilliseconds?: number
}

export interface WebhookInboxWorker {
  start(): void
  stop(): Promise<void>
  drain(): Promise<void>
  pollOnce(): Promise<number>
  isRunning(): boolean
  isReady(): boolean
  inFlightCount(): number
  lastSuccessfulDatabaseOperationAt(): number | null
}

const defaultRepository: WebhookInboxRepository = {
  leaseWebhookEvents,
  renewWebhookEventLease,
  completeWebhookEvent,
  failWebhookEvent,
}

const defaultScheduler: WebhookInboxScheduler = {
  setTimeout(callback, delayMilliseconds) {
    return setTimeout(callback, delayMilliseconds)
  },
  clearTimeout(handle) {
    clearTimeout(handle)
  },
}

const redactSecrets = (message: string): string => message
  .replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    '$1[REDACTADO]',
  )
  .replace(
    /\b(authorization|token|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s,;'"]+/gi,
    '$1=[REDACTADO]',
  )
  .replace(
    /([?&](?:token|secret|api[_-]?key|access[_-]?token)=)[^&\s]+/gi,
    '$1[REDACTADO]',
  )
  .replace(
    /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    '[JWT REDACTADO]',
  )

export function sanitizeWebhookInboxError(error: unknown): string {
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Error interno durante el procesamiento del webhook'
  const boundedMessage = rawMessage.slice(0, WEBHOOK_INBOX_ERROR_MAX_LENGTH * 2)
  const withoutControlCharacters = [...redactSecrets(boundedMessage)]
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 ? ' ' : character
    })
    .join('')
  const safeMessage = withoutControlCharacters
    .replace(/\s+/g, ' ')
    .trim()
  return (safeMessage || 'Error interno durante el procesamiento del webhook')
    .slice(0, WEBHOOK_INBOX_ERROR_MAX_LENGTH)
}

const positiveInteger = (
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}`)
  }
  return value
}

const rpcData = <T>(
  response: WebhookRpcResponse<T>,
  operation: string,
): T => {
  if (response.error) {
    throw new Error(`${operation}: ${response.error.message}`)
  }
  if (response.data === null || response.data === undefined) {
    throw new Error(`${operation}: la RPC no devolvió resultado`)
  }
  return response.data
}

const isLease = (value: unknown): value is WebhookInboxLease => {
  if (!value || typeof value !== 'object') return false
  const lease = value as Partial<WebhookInboxLease>
  return typeof lease.id === 'string'
    && typeof lease.business_id === 'string'
    && (lease.provider === 'meta' || lease.provider === 'ycloud')
    && Boolean(lease.payload)
    && typeof lease.payload === 'object'
    && !Array.isArray(lease.payload)
    && typeof lease.lease_token === 'string'
    && Number.isInteger(lease.attempts)
}

export function createWebhookInboxWorker(
  options: WebhookInboxWorkerOptions,
): WebhookInboxWorker {
  const workerId = options.workerId.trim()
  if (!workerId || workerId.length > 128) {
    throw new Error('workerId debe contener entre 1 y 128 caracteres')
  }

  const batchSize = positiveInteger(options.batchSize ?? 10, 'batchSize', 1, 50)
  const concurrency = positiveInteger(
    options.concurrency ?? 4,
    'concurrency',
    1,
    50,
  )
  const leaseSeconds = positiveInteger(
    options.leaseSeconds ?? 180,
    'leaseSeconds',
    30,
    900,
  )
  const baseDelaySeconds = positiveInteger(
    options.baseDelaySeconds ?? 10,
    'baseDelaySeconds',
    1,
    300,
  )
  const pollIntervalMilliseconds = positiveInteger(
    options.pollIntervalMilliseconds ?? 1_000,
    'pollIntervalMilliseconds',
    0,
    3_600_000,
  )
  const heartbeatIntervalMilliseconds = positiveInteger(
    options.heartbeatIntervalMilliseconds ?? 45_000,
    'heartbeatIntervalMilliseconds',
    1,
    leaseSeconds * 1_000 - 1,
  )
  const readinessTimeoutMilliseconds = positiveInteger(
    options.readinessTimeoutMilliseconds
      ?? Math.max(30_000, heartbeatIntervalMilliseconds * 2),
    'readinessTimeoutMilliseconds',
    1_000,
    3_600_000,
  )
  // No se reservan más filas de las que pueden empezar a procesarse. Así
  // ningún lease queda esperando detrás del semáforo sin heartbeat activo.
  const leaseLimit = Math.min(batchSize, concurrency)

  const repository = options.repository ?? defaultRepository
  const scheduler = options.scheduler ?? defaultScheduler
  const activeEvents = new Set<Promise<void>>()
  let running = false
  let pollTimer: TimerHandle | null = null
  let currentPoll: Promise<number> | null = null
  let lastDatabaseSuccessAt: number | null = null

  const markDatabaseSuccess = (): void => {
    lastDatabaseSuccessAt = Date.now()
  }

  const report = (
    error: unknown,
    context: WebhookInboxWorkerErrorContext,
  ): void => {
    if (!options.onError) return
    try {
      options.onError(new Error(sanitizeWebhookInboxError(error)), context)
    } catch {
      // El observador nunca debe detener el consumo de la bandeja.
    }
  }

  const startHeartbeat = (event: WebhookInboxLease) => {
    let active = true
    let leaseLost = false
    let timer: TimerHandle | null = null
    let renewal: Promise<void> | null = null

    const schedule = (): void => {
      if (!active || leaseLost) return
      timer = scheduler.setTimeout(() => {
        timer = null
        if (!active || leaseLost) return

        const operation = (async () => {
          try {
            const renewed = rpcData(
              await repository.renewWebhookEventLease(
                event.id,
                event.lease_token,
                leaseSeconds,
              ),
              'No se pudo renovar el lease del webhook',
            )
            if (typeof renewed !== 'boolean') {
              throw new Error('La RPC de renovación devolvió un resultado inválido')
            }
            markDatabaseSuccess()
            if (!renewed) {
              leaseLost = true
              report('El lease del webhook ya no pertenece a este worker', {
                phase: 'renew',
                eventId: event.id,
                provider: event.provider,
              })
            }
          } catch (error) {
            // Un fallo de red no prueba pérdida del lease. Se vuelve a intentar
            // en el próximo heartbeat y la mutación final conserva el fencing.
            report(error, {
              phase: 'renew',
              eventId: event.id,
              provider: event.provider,
            })
          }
        })()
        renewal = operation
        void operation.then(() => {
          if (renewal === operation) renewal = null
          schedule()
        })
      }, heartbeatIntervalMilliseconds)
    }

    schedule()

    return async (): Promise<boolean> => {
      active = false
      if (timer) {
        scheduler.clearTimeout(timer)
        timer = null
      }
      if (renewal) await renewal
      return !leaseLost
    }
  }

  const handleEvent = async (event: WebhookInboxLease): Promise<void> => {
    const stopHeartbeat = startHeartbeat(event)
    let processingFailed = false
    let processingError: unknown

    try {
      await options.processEvent(event)
    } catch (error) {
      processingFailed = true
      processingError = error
    }

    const stillOwnsLease = await stopHeartbeat()
    if (!stillOwnsLease) return

    if (processingFailed) {
      const safeError = sanitizeWebhookInboxError(processingError)
      report(processingError, {
        phase: 'process',
        eventId: event.id,
        provider: event.provider,
      })
      try {
        const status = rpcData(
          await repository.failWebhookEvent(
            event.id,
            event.lease_token,
            safeError,
            baseDelaySeconds,
          ),
          'No se pudo registrar el fallo del webhook',
        )
        if (status !== 'pending' && status !== 'dead' && status !== 'stale') {
          throw new Error('La RPC de fallo devolvió un estado inválido')
        }
        markDatabaseSuccess()
        if (status === 'stale') {
          report('El lease expiró antes de registrar el fallo del webhook', {
            phase: 'fail',
            eventId: event.id,
            provider: event.provider,
          })
        } else if (status === 'dead') {
          report('El webhook agotó sus reintentos y requiere revisión', {
            phase: 'dead',
            eventId: event.id,
            provider: event.provider,
          })
        }
      } catch (error) {
        report(error, {
          phase: 'fail',
          eventId: event.id,
          provider: event.provider,
        })
      }
      return
    }

    try {
      const completed = rpcData(
        await repository.completeWebhookEvent(event.id, event.lease_token),
        'No se pudo completar el webhook',
      )
      if (typeof completed !== 'boolean') {
        throw new Error('La RPC de completado devolvió un resultado inválido')
      }
      markDatabaseSuccess()
      if (!completed) {
        report('El lease expiró antes de completar el webhook', {
          phase: 'complete',
          eventId: event.id,
          provider: event.provider,
        })
      }
    } catch (error) {
      // No se marca como fallo después de procesar: el fencing permite que el
      // evento sea reintentado si la confirmación no llegó a PostgreSQL.
      report(error, {
        phase: 'complete',
        eventId: event.id,
        provider: event.provider,
      })
    }
  }

  const trackEvent = async (event: WebhookInboxLease): Promise<void> => {
    const task = handleEvent(event)
    activeEvents.add(task)
    try {
      await task
    } finally {
      activeEvents.delete(task)
    }
  }

  const processWithBoundedConcurrency = async (
    events: WebhookInboxLease[],
  ): Promise<void> => {
    let cursor = 0
    const consume = async (): Promise<void> => {
      while (cursor < events.length) {
        const event = events[cursor]
        cursor += 1
        await trackEvent(event)
      }
    }
    const workers = Array.from(
      { length: Math.min(concurrency, events.length) },
      () => consume(),
    )
    await Promise.all(workers)
  }

  const executePoll = async (): Promise<number> => {
    const leased = rpcData(
      await repository.leaseWebhookEvents(workerId, leaseLimit, leaseSeconds),
      'No se pudieron reservar webhooks',
    )
    if (!Array.isArray(leased)
      || leased.length > leaseLimit
      || !leased.every(isLease)) {
      throw new Error('La RPC de leases devolvió filas inválidas')
    }
    markDatabaseSuccess()
    await processWithBoundedConcurrency(leased)
    return leased.length
  }

  const pollOnce = (): Promise<number> => {
    if (currentPoll) return currentPoll
    const operation = executePoll()
    currentPoll = operation
    void operation.then(
      () => {
        if (currentPoll === operation) currentPoll = null
      },
      () => {
        if (currentPoll === operation) currentPoll = null
      },
    )
    return operation
  }

  const schedulePoll = (delayMilliseconds: number): void => {
    if (!running || pollTimer) return
    pollTimer = scheduler.setTimeout(() => {
      pollTimer = null
      if (!running) return
      void pollOnce()
        .catch(error => report(error, { phase: 'poll' }))
        .then(() => {
          if (running) schedulePoll(pollIntervalMilliseconds)
        })
    }, delayMilliseconds)
  }

  const drain = async (): Promise<void> => {
    while (currentPoll || activeEvents.size) {
      const pending: Promise<unknown>[] = []
      if (currentPoll) pending.push(currentPoll)
      pending.push(...activeEvents)
      await Promise.allSettled(pending)
    }
  }

  const stop = async (): Promise<void> => {
    running = false
    if (pollTimer) {
      scheduler.clearTimeout(pollTimer)
      pollTimer = null
    }
    await drain()
  }

  return {
    start() {
      if (running) return
      running = true
      schedulePoll(0)
    },
    stop,
    drain,
    pollOnce,
    isRunning: () => running,
    isReady: () => {
      if (!running || lastDatabaseSuccessAt === null) return false
      const age = Math.max(0, Date.now() - lastDatabaseSuccessAt)
      return age <= readinessTimeoutMilliseconds
    },
    inFlightCount: () => activeEvents.size,
    lastSuccessfulDatabaseOperationAt: () => lastDatabaseSuccessAt,
  }
}
