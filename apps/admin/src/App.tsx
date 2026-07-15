import { HashRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { session } from './api/client'
import Login from './features/auth/Login'
import Layout from './components/Layout'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const Dashboard = lazy(() => import('./features/dashboard/Dashboard'))
const Clients = lazy(() => import('./features/clients/Clients'))
const Billing = lazy(() => import('./features/billing/Billing'))
const Simulator = lazy(() => import('./features/simulator/Simulator'))
const ServerSettings = lazy(() => import('./features/settings/ServerSettings'))
const Connections = lazy(() => import('./features/settings/Connections'))
const Calculator = lazy(() => import('./features/calculator/Calculator'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

function RequireAuth() {
  return session.token ? <Outlet /> : <Navigate to="/login" replace />
}

const PageLoader = () => <div className="space-y-4"><Skeleton className="h-8 w-56" /><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>

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
              <Route path="/clients" element={<Clients />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/simulator" element={<Simulator />} />
              <Route path="/settings" element={<ServerSettings />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/calculator" element={<Calculator />} />
              <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
