const { spawn } = require('child_process')

let state = { url: null, active: false, proc: null, provider: null, startedAt: null }

// ── Cloudflared (sin cuenta, gratis) ─────────────────────
function startCloudflared(port) {
  return new Promise((resolve, reject) => {
    const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let resolved = false
    const timer = setTimeout(() => {
      if (!resolved) { proc.kill(); reject(new Error('Timeout: cloudflared no respondió en 20s')) }
    }, 20000)

    const parse = data => {
      const text = data.toString()
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m && !resolved) {
        resolved = true
        clearTimeout(timer)
        state = { url: m[0], active: true, proc, provider: 'cloudflared', startedAt: new Date() }
        console.log('🌐 Cloudflare Tunnel activo:', m[0])
        resolve(state)
      }
    }

    proc.stdout.on('data', parse)
    proc.stderr.on('data', parse)
    proc.on('error', err => { clearTimeout(timer); reject(err) })
    proc.on('close', () => {
      if (state.provider === 'cloudflared') state = { url: null, active: false, proc: null, provider: null, startedAt: null }
      console.log('🔌 cloudflared cerrado')
    })
  })
}

// ── LocalTunnel (fallback npm, sin instalación extra) ────
async function startLocaltunnel(port) {
  const lt = require('localtunnel')
  const tunnel = await lt({ port })
  state = { url: tunnel.url, active: true, proc: tunnel, provider: 'localtunnel', startedAt: new Date() }
  console.log('🌐 LocalTunnel activo:', tunnel.url)

  tunnel.on('close', () => {
    state = { url: null, active: false, proc: null, provider: null, startedAt: null }
  })
  tunnel.on('error', err => {
    console.error('❌ Túnel error:', err.message)
  })
  return state
}

// ── API pública ───────────────────────────────────────────
async function startTunnel(port = 3000) {
  if (state.active) return state

  // Intentar cloudflared primero
  try {
    return await startCloudflared(port)
  } catch(e) {
    console.log('⚠️  cloudflared no disponible:', e.message)
    console.log('    → Usando localtunnel como fallback...')
  }

  // Fallback a localtunnel
  try {
    return await startLocaltunnel(port)
  } catch(e) {
    throw new Error(
      'No se pudo iniciar el túnel. Opciones:\n' +
      '1. Instala cloudflared: brew install cloudflared\n' +
      '2. O usa tu propio dominio ingresándolo manualmente en el panel'
    )
  }
}

function stopTunnel() {
  if (!state.active) return
  try {
    if (state.provider === 'cloudflared') state.proc?.kill()
    if (state.provider === 'localtunnel') state.proc?.close()
  } catch(e) {}
  state = { url: null, active: false, proc: null, provider: null, startedAt: null }
  console.log('🔌 Túnel detenido')
}

function getState() {
  return { url: state.url, active: state.active, provider: state.provider, startedAt: state.startedAt }
}

module.exports = { startTunnel, stopTunnel, getState }
