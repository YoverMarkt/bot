// Salud del canal de entrada (WhatsApp/Telegram).
//
// Nació de un incidente real (26-31 jul 2026): el trigger de consumo mensual
// reventaba al insertar en la cola durable, el webhook respondía 503 y YCloud
// terminó dejando de entregar. El bot estuvo CINCO DÍAS sin recibir mensajes y
// nada avisó: `/api/health` seguía en verde porque el proceso vivía.
//
// Este módulo mira lo único que importa de verdad: ¿están ENTRANDO mensajes?
// Todo es lectura y cálculo puro — no envía nada ni escribe en la base.

/** Horas sin un solo mensaje entrante antes de considerar el canal en silencio. */
export const DEFAULT_SILENCE_HOURS = 12

/** Fallos del webhook que se recuerdan en memoria (se pierden al reiniciar). */
const MAX_RECORDED_FAILURES = 50

export type ChannelStatus = 'ok' | 'silencio' | 'nunca_recibio' | 'sin_canal'

export interface WebhookFailure {
  provider: string
  /** Código HTTP con el que se rechazó (503, 401…). */
  status: number
  /** Motivo legible; nunca incluye credenciales ni el cuerpo del mensaje. */
  reason: string
  at: string
}

export interface ChannelActivity {
  businessId: string
  lastInboundAt: string | null
}

export interface DiagnosableBusiness {
  id: string
  name?: string | null
  active?: boolean | null
  suspended?: boolean | null
  // El listado del panel (`getAllBusinesses`) solo expone `whatsapp_number`; los
  // demás llegan según de dónde venga el negocio. Se aceptan todos y basta con
  // uno para dar por configurado el canal.
  whatsapp_number?: string | null
  whatsapp_provider?: string | null
  ycloud_number?: string | null
  telegram_bot_token?: string | null
}

export interface ChannelDiagnosis {
  businessId: string
  name: string
  status: ChannelStatus
  lastInboundAt: string | null
  hoursSinceLastInbound: number | null
  detail: string
}

export interface ChannelHealthReport {
  checkedAt: string
  silenceHours: number
  /** true si algún negocio activo está en silencio o nunca recibió nada. */
  alert: boolean
  businesses: ChannelDiagnosis[]
  recentFailures: WebhookFailure[]
}

// ── Fallos recientes del webhook ────────────────────────────────────────────
// Detección inmediata: cuando el webhook rechaza una entrega sabemos AL MOMENTO
// que algo va mal, sin esperar a que se cumplan las horas de silencio.

const recordedFailures: WebhookFailure[] = []

export function recordWebhookFailure(
  provider: string,
  status: number,
  reason: string,
  at: Date = new Date(),
): void {
  recordedFailures.unshift({
    provider,
    status,
    reason,
    at: at.toISOString(),
  })
  if (recordedFailures.length > MAX_RECORDED_FAILURES) {
    recordedFailures.length = MAX_RECORDED_FAILURES
  }
}

export function getRecentWebhookFailures(limit = 10): WebhookFailure[] {
  return recordedFailures.slice(0, Math.max(0, limit))
}

/** Solo para pruebas: vacía el registro en memoria. */
export function resetWebhookFailures(): void {
  recordedFailures.length = 0
}

// ── Diagnóstico por negocio ─────────────────────────────────────────────────

const hoursBetween = (fromIso: string, now: Date): number | null => {
  const from = new Date(fromIso).getTime()
  if (!Number.isFinite(from)) return null
  return (now.getTime() - from) / (60 * 60 * 1000)
}

const filled = (value: unknown): boolean => (
  typeof value === 'string' && value.trim().length > 0
)

const hasInboundChannel = (business: DiagnosableBusiness): boolean => (
  filled(business.whatsapp_number)
    || filled(business.whatsapp_provider)
    || filled(business.ycloud_number)
    || filled(business.telegram_bot_token)
)

const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * Clasifica cada negocio ACTIVO según cuándo entró su último mensaje.
 * Los dados de baja o suspendidos se omiten: su silencio es esperado y
 * alertar por ellos sería ruido que acabaría haciendo ignorar el aviso.
 */
export function diagnoseChannels(input: {
  businesses: DiagnosableBusiness[]
  activity: ChannelActivity[]
  now?: Date
  silenceHours?: number
}): ChannelHealthReport {
  const now = input.now ?? new Date()
  const silenceHours = input.silenceHours ?? DEFAULT_SILENCE_HOURS
  const lastInboundByBusiness = new Map(
    input.activity.map(entry => [entry.businessId, entry.lastInboundAt]),
  )

  const businesses = input.businesses
    .filter(business => business.active !== false && business.suspended !== true)
    .map((business): ChannelDiagnosis => {
      const name = String(business.name || '(sin nombre)')
      const lastInboundAt = lastInboundByBusiness.get(business.id) ?? null

      // Si alguna vez entró un mensaje, el canal existe: no hace falta deducirlo
      // de las columnas. Esto evita que un listado con campos recortados dé
      // "sin canal" a un negocio en marcha y silencie la alerta para siempre.
      if (!lastInboundAt && !hasInboundChannel(business)) {
        return {
          businessId: business.id,
          name,
          status: 'sin_canal',
          lastInboundAt,
          hoursSinceLastInbound: null,
          detail: 'Sin canal de entrada configurado todavía',
        }
      }

      if (!lastInboundAt) {
        return {
          businessId: business.id,
          name,
          status: 'nunca_recibio',
          lastInboundAt: null,
          hoursSinceLastInbound: null,
          detail: 'Nunca ha entrado un mensaje: revisa el webhook del proveedor',
        }
      }

      const hours = hoursBetween(lastInboundAt, now)
      if (hours === null) {
        return {
          businessId: business.id,
          name,
          status: 'nunca_recibio',
          lastInboundAt,
          hoursSinceLastInbound: null,
          detail: 'La fecha del último mensaje no es válida',
        }
      }

      if (hours >= silenceHours) {
        return {
          businessId: business.id,
          name,
          status: 'silencio',
          lastInboundAt,
          hoursSinceLastInbound: round1(hours),
          detail: `Sin mensajes entrantes desde hace ${round1(hours)} h`,
        }
      }

      return {
        businessId: business.id,
        name,
        status: 'ok',
        lastInboundAt,
        hoursSinceLastInbound: round1(hours),
        detail: `Último mensaje hace ${round1(hours)} h`,
      }
    })

  return {
    checkedAt: now.toISOString(),
    silenceHours,
    alert: businesses.some(
      business => business.status === 'silencio' || business.status === 'nunca_recibio',
    ),
    businesses,
    recentFailures: getRecentWebhookFailures(),
  }
}
