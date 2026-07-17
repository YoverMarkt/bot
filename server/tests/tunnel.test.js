import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createTunnelService } = require('../dist/services/tunnel')

function fakeProcess() {
  const process = new EventEmitter()
  process.stdout = new EventEmitter()
  process.stderr = new EventEmitter()
  process.kill = vi.fn().mockReturnValue(true)
  return process
}

function setup(processes = [fakeProcess()]) {
  let index = 0
  const spawn = vi.fn(() => processes[index++])
  const logger = { log: vi.fn() }
  const callbacks = []
  const setTimer = vi.fn(callback => {
    callbacks.push(callback)
    return { id: callbacks.length }
  })
  const clearTimer = vi.fn()
  const startedAt = new Date('2026-07-12T12:00:00.000Z')
  const service = createTunnelService({
    spawn,
    logger,
    now: () => startedAt,
    timeoutMs: 20_000,
    setTimer,
    clearTimer,
  })
  return {
    service, spawn, logger, callbacks, setTimer, clearTimer, startedAt, processes,
  }
}

describe('servicio de túnel local', () => {
  it('inicia cloudflared y expone únicamente estado serializable', async () => {
    const process = fakeProcess()
    const current = setup([process])
    const pending = current.service.startTunnel(3100)

    expect(current.spawn).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'http://localhost:3100'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    process.stderr.emit(
      'data',
      Buffer.from('INF https://demo-a.trycloudflare.com disponible'),
    )

    await expect(pending).resolves.toEqual({
      url: 'https://demo-a.trycloudflare.com',
      active: true,
      provider: 'cloudflared',
      startedAt: current.startedAt,
    })
    expect(current.service.getState()).not.toHaveProperty('process')
    expect(current.service.getState()).not.toHaveProperty('proc')
    expect(current.clearTimer).toHaveBeenCalledTimes(1)
  })

  it('reutiliza el túnel activo sin crear otro proceso', async () => {
    const process = fakeProcess()
    const current = setup([process])
    const first = current.service.startTunnel(3000)
    process.stdout.emit('data', 'https://demo-a.trycloudflare.com')
    await first

    await expect(current.service.startTunnel(9999)).resolves.toMatchObject({
      url: 'https://demo-a.trycloudflare.com', active: true,
    })
    expect(current.spawn).toHaveBeenCalledTimes(1)
  })

  it('mata el proceso y devuelve un error operativo controlado al vencer el timeout', async () => {
    const process = fakeProcess()
    const current = setup([process])
    const pending = current.service.startTunnel(3000)

    current.callbacks[0]()

    await expect(pending).rejects.toThrow(
      'No se pudo iniciar el túnel. Instala cloudflared',
    )
    expect(process.kill).toHaveBeenCalledTimes(1)
    expect(current.logger.log).toHaveBeenCalledWith(
      '⚠️  cloudflared no disponible:',
      'Timeout: cloudflared no respondió en 20s',
    )
  })

  it('detiene el proceso y limpia el estado público', async () => {
    const process = fakeProcess()
    const current = setup([process])
    const pending = current.service.startTunnel()
    process.stdout.emit('data', 'https://demo-a.trycloudflare.com')
    await pending

    current.service.stopTunnel()

    expect(process.kill).toHaveBeenCalledTimes(1)
    expect(current.service.getState()).toEqual({
      url: null, active: false, provider: null, startedAt: null,
    })
  })

  it('ignora el cierre tardío de un proceso anterior', async () => {
    const firstProcess = fakeProcess()
    const secondProcess = fakeProcess()
    const current = setup([firstProcess, secondProcess])
    const first = current.service.startTunnel()
    firstProcess.stdout.emit('data', 'https://demo-a.trycloudflare.com')
    await first
    current.service.stopTunnel()

    const second = current.service.startTunnel()
    secondProcess.stdout.emit('data', 'https://demo-b.trycloudflare.com')
    await second
    firstProcess.emit('close')

    expect(current.service.getState()).toMatchObject({
      url: 'https://demo-b.trycloudflare.com', active: true,
    })
  })

  it('propaga fallos del proceso con mensaje seguro', async () => {
    const process = fakeProcess()
    const current = setup([process])
    const pending = current.service.startTunnel()
    process.emit('error', new Error('ENOENT'))

    await expect(pending).rejects.toThrow('No se pudo iniciar el túnel')
    expect(current.logger.log).toHaveBeenCalledWith(
      '⚠️  cloudflared no disponible:', 'ENOENT',
    )
  })

  it('mantiene el servicio completamente en TypeScript', () => {
    const service = fs.readFileSync(new URL('../src/services/tunnel.ts', import.meta.url), 'utf8')

    expect(service).not.toContain('@ts-nocheck')
    expect(service).toContain('if (state.process === process)')
    expect(service).toContain('const getState = (): TunnelState')
  })
})
