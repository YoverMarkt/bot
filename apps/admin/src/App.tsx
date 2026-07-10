import { HashRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { session } from './api/client'
import Login from './features/auth/Login'
import Layout from './components/Layout'
import Dashboard from './features/dashboard/Dashboard'
import Clients from './features/clients/Clients'
import Billing from './features/billing/Billing'
import Simulator from './features/simulator/Simulator'
import ServerSettings from './features/settings/ServerSettings'
import Connections from './features/settings/Connections'
import Calculator from './features/calculator/Calculator'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

function RequireAuth() {
  return session.token ? <Outlet /> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
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
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
