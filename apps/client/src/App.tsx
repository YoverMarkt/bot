import { HashRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { session } from './api/client'
import Login from './features/auth/Login'
import Layout from './components/Layout'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { isBookingBiz, isLodgingBiz, useBusinessInfo } from './lib/biz'

const Dashboard = lazy(() => import('./features/dashboard/Dashboard'))
const Conversations = lazy(() => import('./features/conversations/Conversations'))
const Catalog = lazy(() => import('./features/catalog/Catalog'))
const Sales = lazy(() => import('./features/sales/Sales'))
const Reports = lazy(() => import('./features/reports/Reports'))
const Customers = lazy(() => import('./features/customers/Customers'))
const Reactivar = lazy(() => import('./features/customers/Reactivar'))
const Bookings = lazy(() => import('./features/bookings/Bookings'))
const Schedule = lazy(() => import('./features/bookings/Schedule'))
const Settings = lazy(() => import('./features/settings/Settings'))
const BotPrompt = lazy(() => import('./features/settings/BotPrompt'))
const Users = lazy(() => import('./features/settings/Users'))
const Lodging = lazy(() => import('./features/lodging/Lodging'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

// Solo entra quien tiene sesión; si no, al login.
function RequireAuth() {
  return session.token ? <Outlet /> : <Navigate to="/login" replace />
}

function RequireBookings() {
  const { data, isLoading } = useBusinessInfo()
  if (isLoading) return <Skeleton className="h-64 w-full" />
  return isBookingBiz(data?.type, data?.takes_bookings)
    ? <Outlet />
    : <Navigate to="/schedule" replace />
}

function RequireLodging() {
  const { data, isLoading } = useBusinessInfo()
  if (isLoading) return <Skeleton className="h-64 w-full" />
  const canManage = session.user?.role === 'owner'
    || session.user?.permissions.includes('hospedaje')
  return isLodgingBiz(data?.lodging_enabled)
    && canManage
    ? <Outlet />
    : <Navigate to="/" replace />
}

const PageLoader = () => <div className="space-y-4"><Skeleton className="h-8 w-56" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>

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
              <Route path="/reports" element={<Reports />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/reactivate" element={<Reactivar />} />
              <Route path="/bot-prompt" element={<BotPrompt />} />
              <Route path="/policies" element={<Navigate to="/bot-prompt" replace />} />
              <Route path="/users" element={<Users />} />
              <Route element={<RequireLodging />}>
                <Route path="/lodging" element={<Lodging />} />
              </Route>
              <Route element={<RequireBookings />}>
                <Route path="/bookings" element={<Bookings />} />
              </Route>
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
