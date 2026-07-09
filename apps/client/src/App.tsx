import { HashRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { session } from './api/client'
import Login from './features/auth/Login'
import Layout from './components/Layout'
import Dashboard from './features/dashboard/Dashboard'
import Conversations from './features/conversations/Conversations'
import Catalog from './features/catalog/Catalog'
import Sales from './features/sales/Sales'
import Reports from './features/reports/Reports'
import ComingSoon from './components/ComingSoon'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

// Solo entra quien tiene sesión; si no, al login.
function RequireAuth() {
  return session.token ? <Outlet /> : <Navigate to="/login" replace />
}

// HashRouter: funciona servido desde Express en /app sin config extra de rutas.
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/sales" element={<Sales />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/customers" element={<ComingSoon title="Clientes" />} />
              <Route path="/bookings" element={<ComingSoon title="Citas" />} />
              <Route path="/settings" element={<ComingSoon title="Configuración" />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
