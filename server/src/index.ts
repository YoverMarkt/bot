// ── ARRANQUE DEL SERVIDOR ───────────────────────────────────────────
// Este archivo solo compone Express, monta routers y levanta procesos.
// Las rutas, autenticación y lógica de negocio viven en sus módulos tipados.
import path from 'node:path'
import crypto from 'node:crypto'
import type { Server } from 'node:http'
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import { assertEnvironment } from './config/environment'
import { asyncHandler } from './middleware/async'
import { getRecentWebhookFailures } from './services/channel-health'
import { recordError } from './services/error-log'
import {
  checkAllCredentials,
  type MonitorableBusiness,
} from './services/credential-monitor'
import { providerStatusClient } from './integrations/provider-status'
import { activeClientGuard } from './middleware/auth'
import { securityHeaders } from './middleware/security-headers'
import * as bot from './services/bot-entry'
import { processInboundWebhook } from './services/inbound-webhook'
import * as tunnel from './services/tunnel'
import { createWebhookInboxWorker } from './services/webhook-inbox-worker'
import { getBotInstance, setupTelegram } from './integrations/telegram'
import authRouter = require('./routes/auth.routes')
import adminRouter = require('./routes/admin.routes')
import businessRouter = require('./routes/business.routes')
import sessionsRouter = require('./routes/sessions.routes')
import salesRouter = require('./routes/sales.routes')
import reportsRouter = require('./routes/reports.routes')
import bookingsRouter = require('./routes/bookings.routes')
import productsRouter = require('./routes/products.routes')
import ordersRouter = require('./routes/orders.routes')
import webhooksRouter = require('./routes/webhooks.routes')
import lodgingRouter = require('./routes/lodging.routes')
import menuModifiersRouter = require('./routes/menu-modifiers.routes')
import storefrontRouter = require('./routes/storefront.routes')

interface StartupDatabase {
  getProductImageById(productId: string): Promise<{ image_url?: string | null } | null>
  ensureCurrentMonthBilling(): Promise<{
    data: number | null
    error: { message?: string } | null
  }>
  cleanupWebhookEvents(): Promise<{
    data: number | null
    error: { message?: string } | null
  }>
  getLastInboundAt(): Promise<string | null>
  getAllBusinessesWithSecrets(): Promise<MonitorableBusiness[]>
  cleanupPlatformErrors(days?: number): Promise<{
    data: number | null
    error: { message?: string } | null
  }>
}

interface OperationalError extends Error {
  status?: number
  publicMessage?: string
}

type CorsCallback = (error: Error | null, allow?: boolean) => void
type Cors = (options: {
  origin(origin: string | undefined, callback: CorsCallback): void
}) => RequestHandler

const cors = require('cors') as Cors
const db = require('./db') as StartupDatabase
const webhookInboxWorker = createWebhookInboxWorker({
  workerId: `botpanel-${crypto.randomUUID()}`,
  processEvent: event => processInboundWebhook(event.payload, {
    businessId: event.business_id,
    provider: event.provider,
    eventId: event.id,
  }),
  onError: (error, context) => {
    console.error(
      `❌ Inbox webhook [${context.phase}:${context.provider || 'n/a'}:${context.eventId || 'n/a'}]:`,
      error.message,
    )
  },
})

// Al compilar, __dirname es server/dist. Estas raíces conservan exactamente
// las ubicaciones usadas antes desde server/index.js.
const serverRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(serverRoot, '..')
dotenv.config({ path: path.join(serverRoot, '.env') })
const environment = assertEnvironment(process.env)

const app = express()
let httpServer: Server | null = null
let shuttingDown = false

// Railway/producción corre detrás de un proxy. Express necesita la IP real
// para que express-rate-limit no agrupe a todos los visitantes.
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(securityHeaders)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'apagado ordenado')
}

function shutdown(signal: string, error?: unknown): void {
  if (shuttingDown) return
  shuttingDown = true
  const exitCode = error ? 1 : 0
  console.error(`${error ? '🛑' : '⏹️'} ${signal}:`, errorMessage(error))
  const forceExit = setTimeout(() => process.exit(exitCode), 15_000)
  forceExit.unref()

  const closeHttp = new Promise<void>((resolve) => {
    if (!httpServer) return resolve()
    httpServer.close(() => resolve())
  })
  void (async () => {
    await Promise.allSettled([
      closeHttp,
      webhookInboxWorker.stop(),
    ])
    try {
      await bot.drainPendingMessages()
    } catch (drainError) {
      console.error('❌ Error drenando mensajes durante el apagado:', errorMessage(drainError))
    }
    try {
      getBotInstance()?.stop(signal)
    } catch (telegramError) {
      console.error('❌ Error deteniendo Telegram:', errorMessage(telegramError))
    }
    clearTimeout(forceExit)
    process.exit(exitCode)
  })()
}

process.on('uncaughtException', error => shutdown('uncaughtException', error))
process.on('unhandledRejection', reason => shutdown('unhandledRejection', reason))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

function logEnvironment(): void {
  if (environment.recommendedMissing.length) {
    console.warn(
      '⚠️  Faltan variables recomendadas:',
      environment.recommendedMissing.join(', '),
      '\n   Meta necesita META_VERIFY_TOKEN + META_APP_SECRET; YCloud usa el signing secret de cada endpoint.',
    )
  }
  console.log('✅ Variables de entorno críticas: OK')
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || !process.env.BASE_URL) return callback(null, true)
    try {
      return callback(null, origin === new URL(process.env.BASE_URL).origin)
    } catch {
      return callback(new Error('BASE_URL inválida'))
    }
  },
}))

// Capturar raw body para verificar firmas de webhooks.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => { (req as Request).rawBody = buffer },
}))

const noCacheHtml = (response: Response, filePath: string): void => {
  if (filePath.endsWith('.html')) {
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
}

const clientDist = path.join(projectRoot, 'apps/client/dist')
const adminDist = path.join(projectRoot, 'apps/admin/dist')
app.use('/app', express.static(clientDist, { setHeaders: noCacheHtml }))
app.get('/app/*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')))
app.use('/app-admin', express.static(adminDist, { setHeaders: noCacheHtml }))
app.get('/app-admin/*', (_req, res) => res.sendFile(path.join(adminDist, 'index.html')))
// Mini app del negocio: /t/<slug>. La ruta es corta a propósito, porque el
// enlace viaja dentro de un mensaje de WhatsApp.
const storeDist = path.join(projectRoot, 'apps/store/dist')
app.use('/t', express.static(storeDist, { setHeaders: noCacheHtml }))
app.get('/t/*', (_req, res) => res.sendFile(path.join(storeDist, 'index.html')))
// Páginas legales públicas de Vezzper (sin login): las necesita Meta y las ven
// los clientes. Se sirven como HTML estático desde server/public.
const legalRoot = path.join(serverRoot, 'public')
app.get(['/privacidad', '/privacy'], (_req, res) => res.sendFile(path.join(legalRoot, 'privacidad.html')))
app.get(['/terminos', '/terms'], (_req, res) => res.sendFile(path.join(legalRoot, 'terminos.html')))
app.get(['/admin', '/admin/*'], (_req, res) => res.redirect('/app-admin'))
app.get(['/client', '/client/*'], (_req, res) => res.redirect('/app'))
app.get('/', (_req, res) => res.redirect('/app-admin'))

app.use(authRouter)
// El login se resuelve en authRouter. Toda ruta cliente posterior revalida
// usuario, negocio y permisos actuales antes de llegar a su router.
app.use('/api/client', activeClientGuard)
app.use(adminRouter)
app.use(businessRouter)
app.use(sessionsRouter)
app.use(salesRouter)
app.use(reportsRouter)
app.use(bookingsRouter)
app.use(productsRouter)
app.use(menuModifiersRouter)
// Rutas públicas de la mini app: sin JWT, la credencial es el enlace del bot.
app.use(storefrontRouter)
app.use(ordersRouter)
app.use(webhooksRouter)
app.use(lodgingRouter)

const telegramLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit' },
})
app.use('/webhook/telegram', telegramLimiter)

app.get('/api/health', asyncHandler(async (_req: Request, res: Response) => {
  const lastDatabaseSuccess = webhookInboxWorker
    .lastSuccessfulDatabaseOperationAt()
  // ⚠️ `ok` refleja SOLO si este proceso puede trabajar. Railway usa esta ruta
  // como healthcheck: si un canal en silencio la pusiera en 503, reiniciaría el
  // contenedor en bucle y convertiría un aviso en una caída. El estado del canal
  // viaja como dato informativo; para el diagnóstico completo por negocio está
  // /api/admin/channel-health.
  const ok = !shuttingDown && webhookInboxWorker.isReady()
  let lastInboundAt: string | null = null
  try {
    lastInboundAt = await db.getLastInboundAt()
  } catch {
    lastInboundAt = null
  }
  const recentFailures = getRecentWebhookFailures(5)
  res.status(ok ? 200 : 503).json({
    ok,
    time: new Date().toISOString(),
    webhook_inbox: {
      running: webhookInboxWorker.isRunning(),
      ready: webhookInboxWorker.isReady(),
      in_flight: webhookInboxWorker.inFlightCount(),
      last_database_success_at: lastDatabaseSuccess === null
        ? null
        : new Date(lastDatabaseSuccess).toISOString(),
    },
    inbound_channel: {
      last_inbound_at: lastInboundAt,
      hours_since_last_inbound: lastInboundAt === null
        ? null
        : Math.round(
          ((Date.now() - new Date(lastInboundAt).getTime()) / 3_600_000) * 10,
        ) / 10,
      recent_failures: recentFailures.length,
      last_failure: recentFailures[0] || null,
    },
  })
}))

app.get('/api/images/:productId', asyncHandler(async (req: Request, res: Response) => {
  const product = await db.getProductImageById(req.params.productId)
  if (!product?.image_url) return res.status(404).send('No image')

  if (product.image_url.startsWith('data:')) {
    const [header = '', base64 = ''] = product.image_url.split(',')
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
    const buffer = Buffer.from(base64, 'base64')
    res.set('Content-Type', mimeType)
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(buffer)
  }

  return res.redirect(product.image_url)
}))

const handleHttpError: ErrorRequestHandler = (error: OperationalError, req, res, next) => {
  const requestId = req.headers['x-request-id'] || 'sin-id'
  console.error(`❌ HTTP ${req.method} ${req.path} [${requestId}]:`, errorMessage(error))
  // Solo los fallos reales del servidor: un 400 por datos mal enviados es
  // comportamiento normal y llenaría el registro de ruido.
  if (!error.status || error.status >= 500) {
    void recordError({
      // El superadmin no tiene negocio: sus errores quedan como de plataforma.
      businessId: (req.user && 'businessId' in req.user ? req.user.businessId : null) || null,
      category: 'servidor',
      code: error.status || 500,
      message: errorMessage(error),
      context: { method: req.method, path: req.path },
    })
  }
  if (res.headersSent) return next(error)
  return res.status(error.status || 500).json({
    error: error.publicMessage || 'Error interno del servidor',
  })
}
app.use(handleHttpError)

async function generateCurrentMonthBilling(): Promise<void> {
  try {
    const result = await db.ensureCurrentMonthBilling()
    if (result.error) throw new Error(result.error.message || 'RPC sin detalle')
    if (result.data) {
      console.log(`💳 Facturación mensual: ${result.data} cuota(s) generada(s)`)
    }
  } catch (error) {
    console.error('❌ Generación de facturación mensual:', errorMessage(error))
  }
}

async function cleanupWebhookInbox(): Promise<void> {
  try {
    const result = await db.cleanupWebhookEvents()
    if (result.error) throw new Error(result.error.message || 'RPC sin detalle')
    if (result.data) console.log(`🧹 Inbox webhook: ${result.data} evento(s) purgado(s)`)
  } catch (error) {
    console.error('❌ Limpieza del inbox webhook:', errorMessage(error))
  }
}

// Revisa solo, cada pocas horas, que las credenciales de cada negocio sigan
// sirviendo: API key válida, número conectado, webhook apuntando aquí y con
// saldo. El panel ya permitía hacerlo A MANO, y por eso en julio de 2026 nadie
// se enteró de nada durante cinco días.
async function checkCredentials(): Promise<void> {
  try {
    const businesses = await db.getAllBusinessesWithSecrets()
    const problemas = await checkAllCredentials(businesses, providerStatusClient, {
      baseUrl: process.env.BASE_URL,
    })
    if (!problemas.length) {
      console.log('🔐 Credenciales: todos los negocios en orden')
      return
    }
    for (const problema of problemas) {
      const etiqueta = problema.severity === 'error' ? '❌' : '⚠️ '
      console.error(
        `${etiqueta} [${problema.businessName}] ${problema.provider}: ${problema.message}`,
      )
      void recordError({
        businessId: problema.businessId,
        category: 'canal',
        code: problema.code,
        message: problema.message,
        context: { provider: problema.provider, severidad: problema.severity },
      })
    }
  } catch (error) {
    console.error('❌ Revisión de credenciales:', errorMessage(error))
  }
}

// El registro de errores no puede crecer sin fin: se purga lo más viejo de 30
// días. Si la migración todavía no se corrió, el fallo se anota y no molesta.
async function cleanupErrorLog(): Promise<void> {
  try {
    const result = await db.cleanupPlatformErrors()
    if (result.error) throw new Error(result.error.message || 'RPC sin detalle')
    if (result.data) console.log(`🧹 Registro de errores: ${result.data} purgado(s)`)
  } catch (error) {
    console.error('❌ Limpieza del registro de errores:', errorMessage(error))
  }
}

const port = process.env.PORT || 3000
httpServer = app.listen(port, () => {
  logEnvironment()
  console.log(`\n🚀 BotPanel corriendo en http://localhost:${port}`)
  console.log(`👑 Admin:   http://localhost:${port}/app-admin`)
  console.log(`👤 Cliente: http://localhost:${port}/app`)
  console.log(`📡 Webhook: http://localhost:${port}/webhook\n`)

  webhookInboxWorker.start()
  setTimeout(generateCurrentMonthBilling, 3000)
  setInterval(generateCurrentMonthBilling, 24 * 60 * 60 * 1000)
  setTimeout(cleanupWebhookInbox, 5000)
  setInterval(cleanupWebhookInbox, 24 * 60 * 60 * 1000)
  setTimeout(cleanupErrorLog, 7000)
  setInterval(cleanupErrorLog, 24 * 60 * 60 * 1000)
  // Cada 6 h: suficiente para enterarse el mismo día sin castigar a los
  // proveedores con consultas constantes.
  setTimeout(checkCredentials, 20_000)
  setInterval(checkCredentials, 6 * 60 * 60 * 1000)

  setupTelegram(app, bot.handleMessage).then(() => {
    if (process.env.BASE_URL) console.log(`🌐 Producción: ${process.env.BASE_URL}`)
  }).catch(error => console.error('❌ Telegram setup:', errorMessage(error)))

  if (!process.env.BASE_URL) {
    setTimeout(() => {
      tunnel.startTunnel(port)
        .then(state => console.log(`🌐 Túnel automático: ${state.url}`))
        .catch(error => {
          console.log('⚠️  No se pudo auto-iniciar el túnel:', errorMessage(error))
        })
    }, 2500)
  }
})
