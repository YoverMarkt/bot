import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from './lib/theme'

initTheme()   // oscuro por defecto; el usuario puede cambiar a claro desde el menú

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
