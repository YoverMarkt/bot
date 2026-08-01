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
    }
  }
}

export {}
