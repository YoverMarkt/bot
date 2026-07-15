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

    interface Request {
      user?: ClientUserClaims | AdminUserClaims
      rawBody?: Buffer
    }
  }
}

export {}
