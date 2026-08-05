declare global {
  namespace Express {
    interface ClientUserClaims {
      role: 'client'
      businessId: string
      urole?: 'owner' | 'employee'
      perms?: string[]
      userId?: string
      email?: string
      takesBookings?: boolean
      lodgingEnabled?: boolean
    }

    interface AdminUserClaims {
      role: 'admin'
      email?: string
    }

    // Sesión de la mini app. No es un usuario del panel: el cliente entra con
    // el enlace que le mandó el bot, no con contraseña. El middleware la deja
    // ya resuelta para que ninguna ruta tenga que leer el token otra vez.
    interface StorefrontSession {
      businessId: string
      customerId: string
      contactPhone: string
      sessionId: string
    }

    interface Request {
      user?: ClientUserClaims | AdminUserClaims
      rawBody?: Buffer
      storefront?: StorefrontSession
      /**
       * El negocio de la URL, ya resuelto por su slug, en las rutas PÚBLICAS
       * de la tienda (el catálogo). Va aparte de `storefront` a propósito: si
       * un negocio sin sesión llegara dentro de `storefront`, una ruta que lea
       * `storefront.customerId` recibiría un objeto a medias y crearía un
       * pedido sin cliente. Aquí solo hay negocio, y no puede confundirse.
       */
      storeBusinessId?: string
    }
  }
}

export {}
