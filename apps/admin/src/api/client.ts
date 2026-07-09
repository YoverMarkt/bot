// ── Cliente HTTP del panel ADMIN ─────────────────────────────────────
// Usa la MISMA clave de localStorage que el admin viejo (admin_token)
// para compartir sesión durante la migración (patrón estrangulador).

export const session = {
  get token(): string | null { return localStorage.getItem('admin_token') },
  save(token: string) { localStorage.setItem('admin_token', token) },
  clear() { localStorage.removeItem('admin_token') },
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    },
  })
  if (res.status === 401) {
    session.clear()
    window.location.hash = '#/login'
    throw new ApiError(401, 'Sesión vencida. Inicia sesión de nuevo.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error || `Error ${res.status}`)
  return data as T
}
