import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express'
import type { PathParams } from 'express-serve-static-core'

type ExpressHandler = RequestHandler | ErrorRequestHandler
type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'
type RouteRegister = (path: PathParams, ...handlers: ExpressHandler[]) => Router

export function asyncHandler(handler: ExpressHandler): ExpressHandler {
  if (handler.length === 4) return handler

  const requestHandler = handler as RequestHandler
  return function safeHandler(req: Request, res: Response, next: NextFunction) {
    try {
      return Promise.resolve(requestHandler(req, res, next)).catch(next)
    } catch (error) {
      return next(error)
    }
  }
}

// Express 4 no propaga rechazos de handlers async. Este Router envuelve todos
// los handlers registrados sin exigir try/catch repetido en cada endpoint.
export function createRouter(): Router {
  const router = express.Router()
  const routeMethods: RouteMethod[] = ['get', 'post', 'put', 'patch', 'delete']
  const mutableRoutes = router as unknown as Record<RouteMethod, RouteRegister>

  for (const method of routeMethods) {
    const register = mutableRoutes[method].bind(router)
    mutableRoutes[method] = (path, ...handlers) => (
      register(path, ...handlers.map(asyncHandler))
    )
  }

  return router
}
