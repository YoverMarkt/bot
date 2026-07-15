interface TunnelStream {
  on(event: 'data', listener: (data: Buffer | string) => void): void
}

interface TunnelProcess {
  stdout: TunnelStream
  stderr: TunnelStream
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: () => void): void
  kill(): boolean
}

type SpawnTunnel = (
  command: string,
  args: string[],
  options: { stdio: ['ignore', 'pipe', 'pipe'] },
) => TunnelProcess

type TimerHandle = ReturnType<typeof setTimeout>

interface TunnelLogger {
  log(...values: unknown[]): void
}

export interface TunnelState {
  url: string | null
  active: boolean
  provider: 'cloudflared' | null
  startedAt: Date | null
}

interface InternalTunnelState extends TunnelState {
  process: TunnelProcess | null
}

export interface TunnelDependencies {
  spawn: SpawnTunnel
  logger?: TunnelLogger
  now?: () => Date
  timeoutMs?: number
  setTimer?: (callback: () => void, milliseconds: number) => TimerHandle
  clearTimer?: (timer: TimerHandle) => void
}

const emptyState = (): InternalTunnelState => ({
  url: null,
  active: false,
  process: null,
  provider: null,
  startedAt: null,
})

function createTunnelService(dependencies: TunnelDependencies) {
  const logger = dependencies.logger || console
  const now = dependencies.now || (() => new Date())
  const timeoutMs = dependencies.timeoutMs ?? 20_000
  const setTimer = dependencies.setTimer || ((callback, milliseconds) => (
    setTimeout(callback, milliseconds)
  ))
  const clearTimer = dependencies.clearTimer || (timer => clearTimeout(timer))
  let state = emptyState()

  const getState = (): TunnelState => ({
    url: state.url,
    active: state.active,
    provider: state.provider,
    startedAt: state.startedAt,
  })

  function startCloudflared(port: string | number): Promise<TunnelState> {
    return new Promise((resolve, reject) => {
      const process = dependencies.spawn(
        'cloudflared',
        ['tunnel', '--url', `http://localhost:${port}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let settled = false
      const timer = setTimer(() => {
        if (settled) return
        settled = true
        process.kill()
        reject(new Error(`Timeout: cloudflared no respondió en ${timeoutMs / 1000}s`))
      }, timeoutMs)

      const parse = (data: Buffer | string) => {
        const match = String(data).match(
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
        )
        if (!match || settled) return
        settled = true
        clearTimer(timer)
        state = {
          url: match[0],
          active: true,
          process,
          provider: 'cloudflared',
          startedAt: now(),
        }
        logger.log('🌐 Cloudflare Tunnel activo:', match[0])
        resolve(getState())
      }

      process.stdout.on('data', parse)
      process.stderr.on('data', parse)
      process.on('error', (error) => {
        clearTimer(timer)
        if (settled) return
        settled = true
        reject(error)
      })
      process.on('close', () => {
        if (state.process === process) state = emptyState()
        logger.log('🔌 cloudflared cerrado')
      })
    })
  }

  async function startTunnel(port: string | number = 3000): Promise<TunnelState> {
    if (state.active) return getState()
    try {
      return await startCloudflared(port)
    } catch (error) {
      logger.log(
        '⚠️  cloudflared no disponible:',
        error instanceof Error ? error.message : error,
      )
      throw new Error(
        'No se pudo iniciar el túnel. Instala cloudflared (brew install cloudflared) '
        + 'o configura BASE_URL con un dominio propio.',
      )
    }
  }

  function stopTunnel(): void {
    if (!state.active) return
    const process = state.process
    state = emptyState()
    try {
      process?.kill()
    } catch { /* el proceso puede haber terminado entre la lectura y el kill */ }
    logger.log('🔌 Túnel detenido')
  }

  return { getState, startCloudflared, startTunnel, stopTunnel }
}

const childProcess = require('node:child_process') as { spawn: SpawnTunnel }
const tunnel = createTunnelService({ spawn: childProcess.spawn })

export const getState = tunnel.getState
export const startTunnel = tunnel.startTunnel
export const stopTunnel = tunnel.stopTunnel
export { createTunnelService }
