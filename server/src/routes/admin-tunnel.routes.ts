import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import type { TunnelState } from '../services/tunnel'

const tunnel: {
  getState(): TunnelState
  startTunnel(port: string | number): Promise<TunnelState>
  stopTunnel(): void
} = require('../services/tunnel') as typeof import('../services/tunnel')
const auth: {
  authAdmin: RequestHandler
} = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()

router.get('/api/admin/tunnel', auth.authAdmin, (_req, res) => {
  if (process.env.BASE_URL) {
    return res.json({
      url: process.env.BASE_URL,
      active: true,
      provider: 'dominio propio',
      startedAt: null,
    })
  }
  res.json(tunnel.getState())
})

router.post('/api/admin/tunnel/start', auth.authAdmin, async (_req, res) => {
  try {
    res.json(await tunnel.startTunnel(process.env.PORT || 3000))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo iniciar el túnel'
    console.error('❌ iniciar túnel:', message)
    res.status(500).json({ error: message.slice(0, 200) })
  }
})

router.post('/api/admin/tunnel/stop', auth.authAdmin, (_req, res) => {
  tunnel.stopTunnel()
  res.json({ ok: true })
})

// Desactivado por seguridad: ningún frontend recibe URL o keys de Supabase.
router.get('/api/admin/supabase-config', auth.authAdmin, (_req, res) => res.json({}))

export = router
