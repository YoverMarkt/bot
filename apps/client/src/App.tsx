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
import Customers from './features/customers/Customers'
import Reactivar from './features/customers/Reactivar'
import Bookings from './features/bookings/Bookings'
import Schedule from './features/bookings/Schedule'
import Settings from './features/settings/Settings'
import BotPrompt from './features/settings/BotPrompt'
import Users from './features/settings/Users'

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
              <Route path="/customers" element={<Customers />} />
              <Route path="/reactivate" element={<Reactivar />} />
              <Route path="/bot-prompt" element={<BotPrompt />} />
              <Route path="/policies" element={<Navigate to="/bot-prompt" replace />} />
              <Route path="/users" element={<Users />} />
              <Route path="/bookings" element={<Bookings />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
