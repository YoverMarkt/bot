import { describe, expect, it, vi } from 'vitest'
import asyncTools from '../dist/middleware/async.js'

describe('middleware asíncrono de Express', () => {
  it('conserva sin envolver los middlewares de error', () => {
    const errorMiddleware = (error, req, res, next) => next(error)

    expect(asyncTools.asyncHandler(errorMiddleware)).toBe(errorMiddleware)
  })

  it('permite completar handlers asíncronos sin llamar a next', async () => {
    const next = vi.fn()
    const handler = asyncTools.asyncHandler(async (req, res) => {
      res.completed = true
    })
    const response = {}

    await handler({}, response, next)

    expect(response.completed).toBe(true)
    expect(next).not.toHaveBeenCalled()
  })

  it('hace que createRouter propague el rechazo de una ruta real', async () => {
    const expected = new Error('fallo de ruta')
    const router = asyncTools.createRouter()
    router.get('/failure', async () => { throw expected })
    const routeLayer = router.stack.find(layer => layer.route?.path === '/failure')
    const wrappedHandler = routeLayer.route.stack[0].handle
    const next = vi.fn()

    await wrappedHandler({}, {}, next)

    expect(next).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith(expected)
  })
})
