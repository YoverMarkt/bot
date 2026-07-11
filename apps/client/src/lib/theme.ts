// Tema claro/oscuro del panel del cliente (por defecto: claro).
// La preferencia se guarda por navegador; clave propia para no chocar con el admin
// (ambos paneles se sirven desde el mismo origen).

const KEY = 'bp-theme-client'
const DEFAULT: Theme = 'light'

export type Theme = 'light' | 'dark'

export function getTheme(): Theme {
  const t = localStorage.getItem(KEY)
  return t === 'light' || t === 'dark' ? t : DEFAULT
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark')
  localStorage.setItem(KEY, t)
}

// Al arrancar: aplica lo guardado (o el default) sin escribir en storage
export function initTheme() {
  document.documentElement.classList.toggle('dark', getTheme() === 'dark')
}

export function toggleTheme(): Theme {
  const next: Theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
  applyTheme(next)
  return next
}
