import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clipboard,
  Clock3,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Rocket,
  Search,
  Workflow,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  activateBusinessFlowVersion,
  getAdminFlows,
  provisionBusinessFlow,
  publishBusinessFlow,
  setBusinessFlowEnabled,
  type BusinessFlowDefinition,
  type FlowBusiness,
  type FlowTemplate,
} from './api'
import { Alert, AlertDescription, AlertTitle } from '@botpanel/ui/components/alert'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@botpanel/ui/components/card'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Input } from '@botpanel/ui/components/input'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

type ProvisionVariables = {
  businessId: string
  businessName: string
  templateKey: string
}

type DefinitionVariables = {
  businessId: string
  businessName: string
  definitionId: string
  enabled?: boolean
}

const capabilityNames: Record<string, string> = {
  order: 'Pedidos',
  appointment: 'Citas',
  lodging: 'Hospedaje',
  lead: 'Solicitudes',
}

function capabilityLabel(capability: string): string {
  const normalized = String(capability || '').trim().toLowerCase()
  if (capabilityNames[normalized]) return capabilityNames[normalized]
  return normalized
    ? normalized.replaceAll('_', ' ').replace(/^\p{L}/u, letter => letter.toUpperCase())
    : 'General'
}

function normalizedStatus(definition: BusinessFlowDefinition): string {
  return String(definition.status || 'DRAFT').trim().toUpperCase()
}

function updatedAtLabel(value?: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('es-EC', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function StatusBadge({ definition }: { definition: BusinessFlowDefinition }) {
  const status = normalizedStatus(definition)
  if (status === 'PUBLISHED') {
    return (
      <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
        Publicado
      </Badge>
    )
  }
  if (status === 'DEPRECATED') {
    return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Retirado</Badge>
  }
  if (status === 'BLOCKED') {
    return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Bloqueado</Badge>
  }
  if (status === 'FAILED') {
    return <Badge variant="secondary" className="bg-destructive/10 text-destructive">Fallido</Badge>
  }
  if (status === 'PROVISIONING') {
    return (
      <Badge variant="secondary" className="bg-sky-500/10 text-sky-700 dark:text-sky-400">
        Creando
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
      Borrador
    </Badge>
  )
}

function ProviderBadge({ provider }: { provider: FlowBusiness['provider'] }) {
  const normalized = String(provider || '').trim().toLowerCase()
  const supported = normalized === 'meta' || normalized === 'ycloud'
  return (
    <Badge
      variant="secondary"
      className={supported
        ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
        : 'bg-destructive/10 text-destructive'}
    >
      {normalized === 'ycloud'
        ? 'YCloud'
        : normalized === 'meta'
          ? 'Meta directo'
          : normalized || 'Sin proveedor'}
    </Badge>
  )
}

function TemplateCandidate({
  business,
  template,
  busy,
  onProvision,
}: {
  business: FlowBusiness
  template: FlowTemplate
  busy: boolean
  onProvision: () => Promise<unknown>
}) {
  const supportedProvider = business.provider === 'ycloud'
  const canProvision = template.implementation === 'ready'
    && supportedProvider
  const reason = template.implementation !== 'ready'
    ? 'Arquitectura preparada; implementación funcional pendiente.'
    : business.provider === 'meta'
      ? 'El transporte Meta está preparado; su adaptador de publicación segura todavía está pendiente.'
      : !supportedProvider
      ? 'WhatsApp Flows requiere Meta directo o YCloud.'
      : null

  return (
    <div className="flex flex-col justify-between gap-3 rounded-lg border bg-muted/25 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{template.title}</span>
          <Badge variant="outline">v{template.version}</Badge>
          {template.implementation !== 'ready' && <Badge variant="secondary">Próximamente</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
        {reason && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{reason}</p>}
      </div>
      {canProvision ? (
        <ConfirmAction
          trigger={(
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              aria-label={`Crear borrador ${template.title} para ${business.name}`}
            >
              <Plus /> {busy ? 'Creando…' : 'Crear borrador'}
            </Button>
          )}
          title={`Crear ${template.title} para ${business.name}`}
          description="Se creará un Flow en estado borrador dentro de la cuenta WABA del negocio. Todavía no se enviará a clientes ni quedará habilitado."
          confirmLabel="Crear borrador"
          onConfirm={async () => { await onProvision() }}
        />
      ) : (
        <Button variant="outline" size="sm" disabled>
          <Plus /> Crear borrador
        </Button>
      )}
    </div>
  )
}

function DefinitionRow({
  business,
  definition,
  publishing,
  activating,
  toggling,
  reprovisioning,
  onPublish,
  onActivate,
  onToggle,
  onReprovision,
}: {
  business: FlowBusiness
  definition: BusinessFlowDefinition
  publishing: boolean
  activating: boolean
  toggling: boolean
  reprovisioning: boolean
  onPublish: () => Promise<unknown>
  onActivate: () => Promise<unknown>
  onToggle: (enabled: boolean) => Promise<unknown>
  onReprovision: () => Promise<unknown>
}) {
  const status = normalizedStatus(definition)
  const canPublish = status === 'DRAFT' && business.provider === 'ycloud'
  const canActivate = status === 'PUBLISHED'
    && !definition.isActive
    && Boolean(definition.versionId)
  const canToggle = status === 'PUBLISHED' || definition.enabled
  const canReprovision = business.provider === 'ycloud' && (
    status === 'BLOCKED'
    || status === 'FAILED'
    || status === 'DEPRECATED'
    || (status === 'DRAFT' && !definition.providerFlowId)
    || status === 'PUBLISHED'
  )
  const updatedAt = updatedAtLabel(definition.updatedAt)

  async function copyFlowId() {
    if (!definition.providerFlowId) return
    try {
      await navigator.clipboard.writeText(definition.providerFlowId)
      toast.success('Flow ID copiado')
    } catch {
      toast.error('No se pudo copiar el Flow ID')
    }
  }

  return (
    <div className={`rounded-lg border p-3 ${definition.enabled ? 'border-emerald-500/35 bg-emerald-500/[0.03]' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{definition.name}</span>
            <StatusBadge definition={definition} />
            {status === 'PUBLISHED' && (
              <Badge
                variant="secondary"
                className={definition.isActive
                  ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}
              >
                {definition.isActive ? 'Versión activa' : 'Versión candidata'}
              </Badge>
            )}
            <Badge
              variant="secondary"
              className={definition.enabled
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : ''}
            >
              {definition.enabled ? 'Habilitado' : 'Deshabilitado'}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{capabilityLabel(definition.capability)}</span>
            <span>Versión {definition.version}</span>
            {updatedAt && <span>Actualizado {updatedAt}</span>}
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">Flow ID:</span>
            <code className="min-w-0 truncate text-foreground/80" title={definition.providerFlowId || ''}>
              {definition.providerFlowId || 'Pendiente de provisionar'}
            </code>
            {definition.providerFlowId && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => void copyFlowId()}
                aria-label={`Copiar Flow ID de ${definition.name}`}
              >
                <Clipboard />
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {canReprovision && (
            <ConfirmAction
              trigger={(
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reprovisioning}
                  aria-label={`Crear nueva versión de ${definition.name} para ${business.name}`}
                >
                  <RefreshCw /> {reprovisioning ? 'Creando…' : 'Nueva versión'}
                </Button>
              )}
              title={`Crear una nueva versión de ${definition.name}`}
              description="Se conservará el historial actual y se creará otro borrador para corregirlo antes de publicar. No se habilitará automáticamente."
              confirmLabel="Crear nueva versión"
              onConfirm={async () => { await onReprovision() }}
            />
          )}

          {canPublish && (
            <ConfirmAction
              trigger={(
                <Button
                  size="sm"
                  disabled={publishing || !definition.providerFlowId}
                  aria-label={`Publicar ${definition.name} de ${business.name}`}
                >
                  <Rocket /> {publishing ? 'Publicando…' : 'Publicar'}
                </Button>
              )}
              title={`Publicar ${definition.name}`}
              description="Antes de continuar verifica el borrador en WhatsApp Manager. Su estructura ya no podrá modificarse. Si existe otra versión activa, seguirá atendiendo clientes hasta que confirmes el cambio por separado."
              confirmLabel="Publicar versión"
              onConfirm={async () => { await onPublish() }}
            />
          )}

          {canActivate && (
            <ConfirmAction
              trigger={(
                <Button
                  size="sm"
                  disabled={activating || !definition.versionId}
                  aria-label={`Activar versión ${definition.version} de ${definition.name} para ${business.name}`}
                >
                  <CheckCircle2 />
                  {activating ? 'Activando…' : `Activar v${definition.version}`}
                </Button>
              )}
              title={`Activar versión ${definition.version} de ${definition.name}`}
              description={definition.enabled
                ? `Los nuevos clientes pasarán de la versión ${definition.activeVersion ?? 'actual'} a la versión ${definition.version} inmediatamente. Las sesiones ya iniciadas conservarán su versión.`
                : `La versión ${definition.version} quedará seleccionada, pero el Flow seguirá deshabilitado hasta que lo habilites por separado.`}
              confirmLabel={`Activar versión ${definition.version}`}
              onConfirm={async () => { await onActivate() }}
            />
          )}

          {canToggle && (
            <ConfirmAction
              trigger={(
                <Button
                  variant={definition.enabled ? 'outline' : 'secondary'}
                  size="sm"
                  disabled={toggling}
                  aria-label={`${definition.enabled ? 'Deshabilitar' : 'Habilitar'} ${definition.name} de ${business.name}`}
                >
                  {definition.enabled ? <PowerOff /> : <Power />}
                  {toggling
                    ? 'Guardando…'
                    : definition.enabled
                      ? 'Deshabilitar'
                      : 'Habilitar'}
                </Button>
              )}
              title={`${definition.enabled ? 'Deshabilitar' : 'Habilitar'} ${definition.name}`}
              description={definition.enabled
                ? 'El bot dejará de abrir nuevas sesiones con este Flow. Las sesiones ya iniciadas podrán terminar.'
                : 'El bot podrá comenzar a abrir este Flow para los clientes del negocio.'}
              confirmLabel={definition.enabled ? 'Deshabilitar' : 'Habilitar'}
              onConfirm={async () => { await onToggle(!definition.enabled) }}
            />
          )}
        </div>
      </div>

      {status === 'DRAFT' && !definition.providerFlowId && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          El borrador local todavía no tiene un Flow ID del proveedor.
        </p>
      )}
      {status === 'DRAFT' && business.provider === 'meta' && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          La publicación administrada para Meta directo aún no está disponible.
        </p>
      )}
      {status === 'DEPRECATED' && (
        <p className="mt-2 text-xs text-muted-foreground">
          Esta versión fue retirada y se conserva únicamente como historial.
        </p>
      )}
      {status === 'PUBLISHED' && !definition.isActive && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          {definition.activeVersion
            ? `La versión ${definition.activeVersion} continúa activa. Esta versión publicada no atenderá nuevos clientes hasta que confirmes el cambio.`
            : 'Esta versión está publicada, pero todavía debes activarla antes de habilitar el Flow.'}
        </p>
      )}
      {definition.lastError && (
        <Alert variant="destructive" className="mt-3">
          <AlertTriangle />
          <AlertTitle>Último error del proveedor</AlertTitle>
          <AlertDescription className="break-words">
            {definition.lastError}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function BusinessFlowCard({
  business,
  templates,
  provisionMutation,
  publishMutation,
  activateMutation,
  toggleMutation,
}: {
  business: FlowBusiness
  templates: FlowTemplate[]
  provisionMutation: ReturnType<typeof useProvisionMutation>
  publishMutation: ReturnType<typeof usePublishMutation>
  activateMutation: ReturnType<typeof useActivateMutation>
  toggleMutation: ReturnType<typeof useToggleMutation>
}) {
  const recommended = new Set(business.recommendedCapabilities)
  const missingTemplates = templates.filter(template => (
    recommended.has(template.capability)
    && !business.definitions.some(definition => definition.templateKey === template.key)
  ))
  const whatsappProvider = business.provider === 'meta' || business.provider === 'ycloud'

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Building2 className="size-4 text-primary" />
              <span className="truncate">{business.name}</span>
            </CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">{business.type || 'Negocio'}</p>
          </div>
          <ProviderBadge provider={business.provider} />
        </div>

        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded-md bg-muted/60 px-2.5 py-2">
            <div className="text-muted-foreground">Cuenta WABA</div>
            <code className="mt-0.5 block truncate text-foreground/80" title={business.wabaId || ''}>
              {business.wabaId || (
                business.provider === 'ycloud'
                  ? 'Se detectará al crear'
                  : business.provider === 'meta'
                    ? 'Pendiente en Meta'
                    : 'No disponible'
              )}
            </code>
          </div>
          <div className="rounded-md bg-muted/60 px-2.5 py-2">
            <div className="text-muted-foreground">Capacidades recomendadas</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {business.recommendedCapabilities.length
                ? business.recommendedCapabilities.map(capability => (
                    <Badge key={capability} variant="outline">
                      {capabilityLabel(capability)}
                    </Badge>
                  ))
                : <span className="text-foreground/70">Ninguna</span>}
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!whatsappProvider && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Proveedor no compatible</AlertTitle>
            <AlertDescription>
              Configura Meta directo o YCloud para utilizar WhatsApp Flows.
            </AlertDescription>
          </Alert>
        )}
        {business.provider === 'meta' && (
          <Alert>
            <AlertTriangle />
            <AlertTitle>Administración Meta pendiente</AlertTitle>
            <AlertDescription>
              El envío por Meta directo ya está preparado, pero crear y publicar Flows desde este panel estará disponible cuando se complete el adaptador cifrado de Meta.
            </AlertDescription>
          </Alert>
        )}

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Flows configurados
          </h3>
          {business.definitions.length ? (
            <div className="space-y-2">
              {business.definitions.map(definition => {
                const publishing = publishMutation.isPending
                  && publishMutation.variables?.definitionId === definition.id
                const activating = activateMutation.isPending
                  && activateMutation.variables?.definitionId === definition.id
                const toggling = toggleMutation.isPending
                  && toggleMutation.variables?.definitionId === definition.id
                const reprovisioning = provisionMutation.isPending
                  && provisionMutation.variables?.businessId === business.id
                  && provisionMutation.variables.templateKey === definition.templateKey
                return (
                  <DefinitionRow
                    key={definition.id}
                    business={business}
                    definition={definition}
                    publishing={publishing}
                    activating={activating}
                    toggling={toggling}
                    reprovisioning={reprovisioning}
                    onPublish={() => publishMutation.mutateAsync({
                      businessId: business.id,
                      businessName: business.name,
                      definitionId: definition.id,
                    })}
                    onActivate={() => activateMutation.mutateAsync({
                      businessId: business.id,
                      businessName: business.name,
                      definitionId: definition.id,
                      versionId: definition.versionId || '',
                    })}
                    onToggle={enabled => toggleMutation.mutateAsync({
                      businessId: business.id,
                      businessName: business.name,
                      definitionId: definition.id,
                      enabled,
                    })}
                    onReprovision={() => provisionMutation.mutateAsync({
                      businessId: business.id,
                      businessName: business.name,
                      templateKey: definition.templateKey,
                    })}
                  />
                )
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              Este negocio todavía no tiene Flows configurados.
            </div>
          )}
        </section>

        {missingTemplates.length > 0 && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recomendados para este negocio
            </h3>
            <div className="space-y-2">
              {missingTemplates.map(template => {
                const busy = provisionMutation.isPending
                  && provisionMutation.variables?.businessId === business.id
                  && provisionMutation.variables.templateKey === template.key
                return (
                  <TemplateCandidate
                    key={template.key}
                    business={business}
                    template={template}
                    busy={busy}
                    onProvision={() => provisionMutation.mutateAsync({
                      businessId: business.id,
                      businessName: business.name,
                      templateKey: template.key,
                    })}
                  />
                )
              })}
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  )
}

function useProvisionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables: ProvisionVariables) => (
      provisionBusinessFlow(variables.businessId, variables.templateKey)
    ),
    onSuccess: (_result, variables) => {
      toast.success(`Borrador creado para ${variables.businessName}`)
      void queryClient.invalidateQueries({ queryKey: ['adm-flows'] })
    },
    onError: error => toast.error(
      error instanceof Error ? error.message : 'No se pudo crear el borrador',
    ),
  })
}

function usePublishMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables: DefinitionVariables) => (
      publishBusinessFlow(variables.businessId, variables.definitionId)
    ),
    onSuccess: (result, variables) => {
      toast.success(
        result.activationRequired
          ? `Versión publicada para ${variables.businessName}; falta activarla`
          : `Flow publicado para ${variables.businessName}`,
      )
      void queryClient.invalidateQueries({ queryKey: ['adm-flows'] })
    },
    onError: error => toast.error(
      error instanceof Error ? error.message : 'No se pudo publicar el Flow',
    ),
  })
}

function useActivateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables: DefinitionVariables & { versionId: string }) => (
      activateBusinessFlowVersion(
        variables.businessId,
        variables.definitionId,
        variables.versionId,
      )
    ),
    onSuccess: (_result, variables) => {
      toast.success(`Nueva versión activa para ${variables.businessName}`)
      void queryClient.invalidateQueries({ queryKey: ['adm-flows'] })
    },
    onError: error => toast.error(
      error instanceof Error ? error.message : 'No se pudo activar la versión',
    ),
  })
}

function useToggleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (variables: DefinitionVariables) => (
      setBusinessFlowEnabled(
        variables.businessId,
        variables.definitionId,
        variables.enabled === true,
      )
    ),
    onSuccess: (_result, variables) => {
      toast.success(variables.enabled ? 'Flow habilitado' : 'Flow deshabilitado')
      void queryClient.invalidateQueries({ queryKey: ['adm-flows'] })
    },
    onError: error => toast.error(
      error instanceof Error ? error.message : 'No se pudo actualizar el Flow',
    ),
  })
}

export default function Flows() {
  const [search, setSearch] = useState('')
  const query = useQuery({
    queryKey: ['adm-flows'],
    queryFn: getAdminFlows,
  })
  const provisionMutation = useProvisionMutation()
  const publishMutation = usePublishMutation()
  const activateMutation = useActivateMutation()
  const toggleMutation = useToggleMutation()

  const businesses = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase('es')
    return (query.data?.businesses || [])
      .filter(business => {
        if (!normalizedSearch) return true
        const searchable = [
          business.name,
          business.type,
          business.provider,
          business.wabaId,
          ...business.recommendedCapabilities.map(capabilityLabel),
        ].filter(Boolean).join(' ').toLocaleLowerCase('es')
        return searchable.includes(normalizedSearch)
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'es'))
  }, [query.data?.businesses, search])

  const summary = useMemo(() => {
    const allBusinesses = query.data?.businesses || []
    const definitions = allBusinesses.flatMap(business => business.definitions)
    const templates = query.data?.templates || []
    const pendingTemplates = allBusinesses.reduce((total, business) => {
      const recommended = new Set(business.recommendedCapabilities)
      return total + templates.filter(template => (
        business.provider === 'ycloud'
        &&
        template.implementation === 'ready'
        && recommended.has(template.capability)
        && !business.definitions.some(definition => definition.templateKey === template.key)
      )).length
    }, 0)
    return {
      businesses: allBusinesses.length,
      published: definitions.filter(definition => normalizedStatus(definition) === 'PUBLISHED').length,
      enabled: definitions.filter(definition => definition.enabled).length,
      pending: definitions.filter(definition => (
        normalizedStatus(definition) !== 'PUBLISHED'
        && normalizedStatus(definition) !== 'DEPRECATED'
      )).length
        + pendingTemplates,
    }
  }, [query.data])

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Workflow className="size-6 text-primary" /> WhatsApp Flows
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Crea y controla formularios estructurados por negocio. Un borrador nunca se habilita automáticamente.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={query.isFetching ? 'animate-spin' : ''} />
          {query.isFetching ? 'Actualizando…' : 'Actualizar'}
        </Button>
      </div>

      <Alert className="mb-5">
        <AlertTriangle />
        <AlertTitle>Publicación controlada</AlertTitle>
        <AlertDescription>
          Primero crea y prueba el borrador. Publicar, activar una versión y habilitar el Flow son acciones controladas para evitar cambios accidentales en clientes.
        </AlertDescription>
      </Alert>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Negocios', value: summary.businesses, icon: Building2, color: '' },
          { label: 'Publicados', value: summary.published, icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Habilitados', value: summary.enabled, icon: Power, color: 'text-sky-600 dark:text-sky-400' },
          { label: 'Por preparar', value: summary.pending, icon: Clock3, color: 'text-amber-600 dark:text-amber-400' },
        ].map(item => (
          <Card key={item.label} className="py-4">
            <CardContent>
              <div className={`flex items-center gap-1.5 text-xs ${item.color || 'text-muted-foreground'}`}>
                <item.icon className="size-3.5" /> {item.label}
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{item.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Buscar por negocio, tipo, proveedor o capacidad…"
          aria-label="Buscar negocios y Flows"
          className="max-w-xl pl-9"
        />
      </div>

      {query.isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-96 rounded-xl" />
          ))}
        </div>
      ) : query.isError ? (
        <QueryError onRetry={() => { void query.refetch() }} />
      ) : businesses.length ? (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {businesses.map(business => (
            <BusinessFlowCard
              key={business.id}
              business={business}
              templates={query.data?.templates || []}
              provisionMutation={provisionMutation}
              publishMutation={publishMutation}
              activateMutation={activateMutation}
              toggleMutation={toggleMutation}
            />
          ))}
        </div>
      ) : (
        <Card className="p-8 text-center text-muted-foreground">
          {search
            ? 'No hay negocios que coincidan con la búsqueda.'
            : 'Todavía no hay negocios disponibles para configurar Flows.'}
        </Card>
      )}
    </div>
  )
}
