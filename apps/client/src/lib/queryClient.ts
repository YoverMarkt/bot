// Cliente de queries ÚNICO del panel. Vive fuera de App para poder limpiarlo
// en login, logout y expiración de sesión: sin esa limpieza, al entrar con
// otro negocio el panel hereda el caché (módulos y datos) del anterior.
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})
