import { HashRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { session } from './api/client'
import { queryClient } from './lib/queryClient'
import Login from './features/auth/Login'
import Layout from './components/Layout'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const Dashboard = lazy(() => import('./features/dashboard/Dashboard'))
const Conversations = lazy(() => import('./features/conversations/Conversations'))
const Catalog = lazy(() => import('./features/catalog/Catalog'))
const Sales = lazy(() => import('./features/sales/Sales'))
const Orders = lazy(() => import('./features/orders/Orders'))
const Reports = lazy(() => import('./features/reports/Reports'))
const Customers = lazy(() => import('./features/customers/Customers'))
const Reactivar = lazy(() => import('./features/customers/Reactivar'))
const Schedule = lazy(() => import('./features/schedule/Schedule'))
const Settings = lazy(() => import('./features/settings/Settings'))
const Bienvenida = lazy(() => import('./features/settings/Bienvenida'))
const Users = lazy(() => import('./features/settings/Users'))

// Solo entra quien tiene sesión; si no, al login.
function RequireAuth() {
  return session.token ? <Outlet /> : <Navigate to="/login" replace />
}

const PageLoader = () => (
  <div>
    <Skeleton className="h-8 w-56 mb-6" />
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
    </div>
    <div className="grid lg:grid-cols-2 gap-4">
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  </div>
)

// HashRouter: funciona servido desde Express en /app sin config extra de rutas.
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route element={<Suspense fallback={<PageLoader />}><Outlet /></Suspense>}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/sales" element={<Sales />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/reactivate" element={<Reactivar />} />
              <Route path="/bienvenida" element={<Bienvenida />} />
              <Route path="/policies" element={<Navigate to="/bienvenida" replace />} />
              {/* El enlace viejo sigue funcionando: alguien puede tenerlo guardado. */}
              <Route path="/bot-prompt" element={<Navigate to="/bienvenida" replace />} />
              <Route path="/users" element={<Users />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
