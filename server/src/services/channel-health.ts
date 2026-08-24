// Salud del canal de entrada (WhatsApp/Telegram).
//
// Nació de un incidente real (26-31 jul 2026): el trigger de consumo mensual
// reventaba al insertar en la cola durable, el webhook respondía 503 y YCloud
// terminó dejando de entregar. El bot estuvo CINCO DÍAS sin recibir mensajes y
// nada avisó: `/api/health` seguía en verde porque el proceso vivía.
//
// Este módulo mira lo único que importa de verdad: ¿están ENTRANDO mensajes?
// El diagnóstico es cálculo puro; lo único que escribe es el rastro del fallo
// en el registro de errores, y siempre sin bloquear a quien lo llamó.
//
// ⚠️ HAY UN SOLO CANAL DE ENTRADA, y hasta el 2026-08-23 esto no lo sabía.
// Diagnosticaba un semáforo POR LOCAL leyendo `webhook_inbound_events` filtrado
// por `business_id`, y los mensajes del marketplace se encolan con ese campo
// NULL: ningún local volvía a registrar un entrante JAMÁS, así que a las 12 h
// todos caían en `silencio` y la alarma sonaba en falso para siempre.
//
// El diagnóstico que vale hoy es el del NÚMERO de la plataforma. El semáforo
// por negocio SE CONSERVA porque el canal propio sigue existiendo en el código
// (`ycloud`, `meta`, `telegram`), pero solo se aplica a quien lo tiene: un
// local de marketplace no tiene canal suyo que pueda estar mudo — tiene el de
// la plataforma, que se diagnostica UNA vez y no una por local.

import { recordError } from './error-log'

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

/**
 * La salud del NÚMERO DE LA PLATAFORMA: el canal por el que entra todo.
 *
 * No lleva `businessId` a propósito. El número no pertenece a ningún local, y
 * es la misma razón por la que sus credenciales viven en `server_settings` y
 * no en la ficha de un negocio.
 */
export interface PlatformChannelDiagnosis {
  status: ChannelStatus
  lastInboundAt: string | null
  hoursSinceLastInbound: number | null
  detail: string
}

/** Lo que hace falta saber del canal de la plataforma para diagnosticarlo. */
export interface PlatformChannelActivity {
  /** ¿Hay número de marketplace puesto en `server_settings`? */
  configured: boolean
  /** Último entrante con `business_id` NULL, o null si nunca entró ninguno. */
  lastInboundAt: string | null
}

export interface ChannelHealthReport {
  checkedAt: string
  silenceHours: number
  /**
   * true si el número de la plataforma está mudo, o si algún negocio con canal
   * PROPIO lo está.
   */
  alert: boolean
  /** El número de Umbani. Lo que antes era una fila por local. */
  platform: PlatformChannelDiagnosis
  /** Solo los negocios con canal propio: hoy, ninguno. */
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
  businessId: string | null = null,
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
  // Además del registro en memoria (inmediato pero volátil), queda constancia
  // duradera para el panel. Sin await: registrar nunca debe frenar el webhook.
  void recordError({
    businessId,
    category: 'canal',
    code: status,
    message: reason,
    context: { provider },
  })
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
 * ¿Un negocio tiene canal de entrada PROPIO?
 *
 * `marketplace` significa exactamente lo contrario: sus clientes escriben al
 * número de la plataforma. Diagnosticarlo por separado le daría siempre
 * «silencio» —sus mensajes se encolan sin `business_id`— y esa alarma falsa,
 * repetida por cada local, es lo que acaba haciendo que nadie mire el aviso el
 * día que sea de verdad.
 */
export const tieneCanalPropio = (business: DiagnosableBusiness): boolean => (
  String(business.whatsapp_provider || '').trim() !== 'marketplace'
)

/**
 * Diagnostica el NÚMERO DE LA PLATAFORMA.
 *
 * Es la pieza que faltaba: el semáforo por local respondía «¿le llegan
 * mensajes a este negocio?», una pregunta que con un número compartido ya no
 * tiene respuesta en la cola. La que sí la tiene es «¿está entrando algo por
 * el número de Umbani?».
 */
export function diagnosePlatformChannel(
  activity: PlatformChannelActivity,
  now: Date,
  silenceHours: number,
): PlatformChannelDiagnosis {
  // Sin número configurado no hay canal que pueda estar mudo. No alerta aquí
  // —sería un aviso permanente en una instalación recién montada—: de eso avisa
  // `credential-monitor`, que sí sabe que hay locales esperándolo.
  if (!activity.configured) {
    return {
      status: 'sin_canal',
      lastInboundAt: activity.lastInboundAt,
      hoursSinceLastInbound: null,
      detail: 'Sin número de marketplace configurado (Ajustes del servidor)',
    }
  }
  if (!activity.lastInboundAt) {
    return {
      status: 'nunca_recibio',
      lastInboundAt: null,
      hoursSinceLastInbound: null,
      detail: 'Nunca ha entrado un mensaje: revisa el webhook en YCloud',
    }
  }
  const hours = hoursBetween(activity.lastInboundAt, now)
  if (hours === null) {
    return {
      status: 'nunca_recibio',
      lastInboundAt: activity.lastInboundAt,
      hoursSinceLastInbound: null,
      detail: 'La fecha del último mensaje no es válida',
    }
  }
  if (hours >= silenceHours) {
    return {
      status: 'silencio',
      lastInboundAt: activity.lastInboundAt,
      hoursSinceLastInbound: round1(hours),
      detail: `Sin mensajes entrantes desde hace ${round1(hours)} h`,
    }
  }
  return {
    status: 'ok',
    lastInboundAt: activity.lastInboundAt,
    hoursSinceLastInbound: round1(hours),
    detail: `Último mensaje hace ${round1(hours)} h`,
  }
}

/**
 * El estado del canal de entrada: el número de la plataforma, más los negocios
 * que además tengan canal PROPIO.
 *
 * Los dados de baja o suspendidos se omiten: su silencio es esperado y alertar
 * por ellos sería ruido que acabaría haciendo ignorar el aviso. Los del
 * marketplace también, por el motivo de `tieneCanalPropio`.
 */
export function diagnoseChannels(input: {
  businesses: DiagnosableBusiness[]
  activity: ChannelActivity[]
  platform?: PlatformChannelActivity
  now?: Date
  silenceHours?: number
}): ChannelHealthReport {
  const now = input.now ?? new Date()
  const silenceHours = input.silenceHours ?? DEFAULT_SILENCE_HOURS
  const lastInboundByBusiness = new Map(
    input.activity.map(entry => [entry.businessId, entry.lastInboundAt]),
  )
  const platform = diagnosePlatformChannel(
    input.platform ?? { configured: false, lastInboundAt: null },
    now,
    silenceHours,
  )

  const businesses = input.businesses
    .filter(business => business.active !== false && business.suspended !== true)
    .filter(tieneCanalPropio)
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

  const mudo = (status: ChannelStatus): boolean => (
    status === 'silencio' || status === 'nunca_recibio'
  )

  return {
    checkedAt: now.toISOString(),
    silenceHours,
    // El número de la plataforma pesa por sí solo: si está mudo, lo están
    // TODOS los locales a la vez, aunque la lista de negocios salga vacía.
    alert: mudo(platform.status) || businesses.some(b => mudo(b.status)),
    platform,
    businesses,
    recentFailures: getRecentWebhookFailures(),
  }
}
