import { useMemo, useState } from 'react'
import { BUSINESS_TYPE_OPTIONS } from '../clients/business-types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  archivePricingRule, createPricingRule, getClients, getMarkupSummary,
  getPricingRules, replacePricingRule, simulateMarkup,
  type PricingRule, type PricingRuleDraft,
} from '../clients/api'
import { Archive, Calculator, Plus } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@botpanel/ui/components/table'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// ═══════════════════════════════════════════════════════════════════════════
// FINANZAS — LO QUE GANA LA PLATAFORMA
// ═══════════════════════════════════════════════════════════════════════════
//
// El interruptor del motor de margen. Sin esta pantalla el motor está
// instalado y apagado: no había forma de crear una regla.
//
// ⚠️ Aquí NO se calcula ni un centavo. El importe lo calcula PostgreSQL y lo
// sella un disparador sobre `orders` (regla inviolable #8). El simulador
// tampoco: pregunta al servidor, que usa el espejo en TypeScript de la misma
// lógica. Si esta pantalla hiciera sus cuentas, mostraría un número y se
// cobraría otro.

const dinero = (v: number | string) => `$${Number(v || 0).toFixed(2)}`

const ETIQUETA_AMBITO: Record<PricingRule['scope'], string> = {
  business: 'Un negocio',
  business_type: 'Un tipo',
  global: 'Toda la plataforma',
}

const ETIQUETA_ESTRATEGIA: Record<PricingRule['strategy'], string> = {
  percentage: 'Porcentaje',
  fixed: 'Monto fijo',
  tiered: 'Por tramos',
}

/** Cómo cobra una regla, en una línea legible. */
const comoCobra = (r: PricingRule): string => {
  const frenos = [
    r.min_amount != null ? `mínimo ${dinero(r.min_amount)}` : null,
    r.max_amount != null ? `máximo ${dinero(r.max_amount)}` : null,
  ].filter(Boolean).join(' · ')

  const base = r.strategy === 'percentage' ? `${r.percentage}%`
    : r.strategy === 'fixed' ? dinero(r.fixed_amount || 0)
      : `${r.tiers?.length || 0} tramos`

  return frenos ? `${base} — ${frenos}` : base
}

const BORRADOR_INICIAL: PricingRuleDraft = {
  scope: 'business',
  business_id: '',
  strategy: 'percentage',
  percentage: 10,
  min_amount: null,
  max_amount: null,
  markup_mode: 'absorbed',
}

export default function Finance() {
  const qc = useQueryClient()
  const [borrador, setBorrador] = useState<PricingRuleDraft>(BORRADOR_INICIAL)
  const [reemplazando, setReemplazando] = useState<string | null>(null)
  const [subtotal, setSubtotal] = useState(20)
  const [error, setError] = useState('')

  const reglas = useQuery({ queryKey: ['adm-pricing-rules'], queryFn: getPricingRules })
  const resumen = useQuery({ queryKey: ['adm-markup-summary'], queryFn: getMarkupSummary })
  const negocios = useQuery({ queryKey: ['adm-clients-min'], queryFn: getClients })

  // ¿Está la regla lo bastante completa como para poder simularla?
  //
  // Sin esta comprobación el simulador pedía al servidor en CADA tecleo, y
  // mientras faltara el negocio respondía 400: un error rojo en la consola por
  // pulsación y una petición tirada por letra.
  const listaParaSimular = (
    (borrador.scope !== 'business' || !!borrador.business_id)
    && (borrador.scope !== 'business_type' || !!borrador.target_name)
    && (borrador.strategy !== 'percentage' || borrador.percentage != null)
    && (borrador.strategy !== 'fixed' || borrador.fixed_amount != null)
    && subtotal >= 0
  )

  // La simulación la responde el SERVIDOR, no esta pantalla: es la única
  // forma de que lo que se ve sea lo que se va a cobrar.
  const simulacion = useQuery({
    queryKey: ['adm-simulate', borrador, subtotal],
    queryFn: () => simulateMarkup(borrador, subtotal),
    // Una regla a medio escribir da 400: no es un fallo que valga reintentar.
    retry: false,
    enabled: listaParaSimular,
  })

  const tras = () => {
    qc.invalidateQueries({ queryKey: ['adm-pricing-rules'] })
    qc.invalidateQueries({ queryKey: ['adm-markup-summary'] })
    setError('')
  }

  const guardar = useMutation({
    mutationFn: () => (reemplazando
      ? replacePricingRule(reemplazando, borrador)
      : createPricingRule(borrador)),
    onSuccess: () => { setReemplazando(null); tras() },
    onError: (e: Error) => setError(e.message),
  })

  const archivar = useMutation({
    mutationFn: archivePricingRule,
    onSuccess: tras,
    onError: (e: Error) => setError(e.message),
  })

  const activas = useMemo(
    () => (reglas.data || []).filter(r => r.status === 'active'),
    [reglas.data],
  )
  const archivadas = useMemo(
    () => (reglas.data || []).filter(r => r.status !== 'active'),
    [reglas.data],
  )

  const totalMargen = (resumen.data || []).reduce((s, r) => s + Number(r.margen || 0), 0)
  const totalBruto = (resumen.data || []).reduce((s, r) => s + Number(r.bruto || 0), 0)

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Finanzas</h1>
        <p className="text-sm text-muted-foreground">
          Cuánto gana la plataforma con cada pedido. Sin reglas activas no se cobra comisión a nadie.
        </p>
      </div>

      {/* ── Lo acumulado este mes ─────────────────────────────────────── */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Vendido este mes</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{dinero(totalBruto)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Comisión acumulada</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-primary">{dinero(totalMargen)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Reglas activas</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{activas.length}</p>
        </Card>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          {/* ── Reglas activas ──────────────────────────────────────────── */}
          <Card className="mb-6 overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h2 className="font-semibold text-foreground">Reglas activas</h2>
              <p className="text-xs text-muted-foreground">
                Manda la más específica: negocio, luego tipo, luego global.
              </p>
            </div>
            {reglas.isLoading
              ? <div className="space-y-2 p-4"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              : reglas.isError
                ? <div className="p-4"><QueryError onRetry={() => reglas.refetch()} /></div>
                : activas.length === 0
                  ? (
                    <p className="p-6 text-center text-sm text-muted-foreground">
                      No hay ninguna regla activa, así que hoy no se cobra comisión.
                      Crea la primera con el formulario de al lado.
                    </p>
                  )
                  : (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Aplica a</TableHead>
                            <TableHead>Cómo cobra</TableHead>
                            <TableHead>Modo</TableHead>
                            <TableHead className="text-right">Versión</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {activas.map(r => (
                            <TableRow key={r.id}>
                              <TableCell>
                                <span className="font-medium text-foreground">
                                  {r.businesses?.name || r.target_name || ETIQUETA_AMBITO[r.scope]}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {ETIQUETA_AMBITO[r.scope]} · {ETIQUETA_ESTRATEGIA[r.strategy]}
                                </span>
                              </TableCell>
                              <TableCell className="tabular-nums">{comoCobra(r)}</TableCell>
                              <TableCell>
                                <Badge variant={r.markup_mode === 'on_top' ? 'default' : 'secondary'}>
                                  {r.markup_mode === 'on_top' ? 'Se suma al cliente' : 'Sale del comercio'}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{r.version}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost" size="sm"
                                  disabled={archivar.isPending}
                                  onClick={() => archivar.mutate(r.id)}
                                >
                                  <span className="inline-flex items-center gap-1.5">
                                    <Archive className="h-4 w-4" /> Archivar
                                  </span>
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
          </Card>

          {/* ── Lo acumulado por negocio ────────────────────────────────── */}
          <Card className="overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h2 className="font-semibold text-foreground">Acumulado por negocio</h2>
              <p className="text-xs text-muted-foreground">
                Cuenta al ENTREGAR el pedido. Una venta anulada deja de contar.
              </p>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Negocio</TableHead>
                    <TableHead className="text-right">Pedidos</TableHead>
                    <TableHead className="text-right">Vendido</TableHead>
                    <TableHead className="text-right">Se queda</TableHead>
                    <TableHead className="text-right">Nos debe</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(resumen.data || []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                        Todavía no hay ventas este mes.
                      </TableCell>
                    </TableRow>
                  )}
                  {(resumen.data || []).map(f => (
                    <TableRow key={f.business_id}>
                      <TableCell className="font-medium text-foreground">{f.business_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.pedidos}</TableCell>
                      <TableCell className="text-right tabular-nums">{dinero(f.bruto)}</TableCell>
                      <TableCell className="text-right tabular-nums">{dinero(f.comercio)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-primary">
                        {dinero(f.margen)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        </div>

        {/* ── Crear una regla, con el simulador al lado ────────────────── */}
        <Card className="h-fit p-4">
          <h2 className="mb-1 font-semibold text-foreground">
            {reemplazando ? 'Reemplazar la regla' : 'Nueva regla'}
          </h2>
          <p className="mb-4 text-xs text-muted-foreground">
            {reemplazando
              ? 'Se crea una versión nueva y la anterior se archiva. Los pedidos ya cobrados no cambian.'
              : 'Se aplica a los pedidos NUEVOS. Los ya cobrados conservan su regla.'}
          </p>

          <div className="space-y-3">
            <div>
              <Label htmlFor="ambito">Aplica a</Label>
              <select
                id="ambito"
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={borrador.scope}
                onChange={e => setBorrador({
                  ...borrador,
                  scope: e.target.value as PricingRule['scope'],
                  business_id: '', target_name: '',
                })}
              >
                <option value="business">Un negocio</option>
                <option value="business_type">Un tipo de negocio</option>
                <option value="global">Toda la plataforma</option>
              </select>
            </div>

            {borrador.scope === 'business' && (
              <div>
                <Label htmlFor="negocio">Negocio</Label>
                <select
                  id="negocio"
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={borrador.business_id || ''}
                  onChange={e => setBorrador({ ...borrador, business_id: e.target.value })}
                >
                  <option value="">Elige uno…</option>
                  {(negocios.data || []).map(n => (
                    <option key={n.id} value={n.id}>{n.name}</option>
                  ))}
                </select>
              </div>
            )}

            {borrador.scope === 'business_type' && (
              <div>
                <Label htmlFor="tipo">Tipo de negocio</Label>
                {/* ⚠️ LISTA CERRADA, no texto libre. Escribiéndolo a mano se
                    creó una regla con el tipo «Monster Pizza» —que es un
                    NEGOCIO, no un tipo—: no casaba con nada y no se aplicó
                    nunca, sin que nada avisara. El nombre tiene que coincidir
                    exacto con `businesses.type` o la regla es decorativa. */}
                <select
                  id="tipo"
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={borrador.target_name || ''}
                  onChange={e => setBorrador({ ...borrador, target_name: e.target.value })}
                >
                  <option value="">Elige uno…</option>
                  {BUSINESS_TYPE_OPTIONS.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Se aplica a todos los locales de ese tipo. Un negocio concreto
                  puede llevar su propia regla y gana sobre esta.
                </p>
              </div>
            )}

            <div>
              <Label htmlFor="estrategia">Cómo cobra</Label>
              <select
                id="estrategia"
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={borrador.strategy}
                onChange={e => setBorrador({
                  ...borrador,
                  strategy: e.target.value as PricingRule['strategy'],
                  percentage: e.target.value === 'percentage' ? 10 : null,
                  fixed_amount: e.target.value === 'fixed' ? 0.5 : null,
                  tiers: e.target.value === 'tiered' ? [{ up_to: 10, amount: 0.5 }, { up_to: null, amount: 1.5 }] : null,
                })}
              >
                <option value="percentage">Porcentaje</option>
                <option value="fixed">Monto fijo</option>
                <option value="tiered">Por tramos</option>
              </select>
            </div>

            {borrador.strategy === 'percentage' && (
              <div>
                <Label htmlFor="pct">Porcentaje</Label>
                <Input
                  id="pct" type="number" min={0} max={100} step="0.1" className="mt-1"
                  value={borrador.percentage ?? ''}
                  onChange={e => setBorrador({ ...borrador, percentage: Number(e.target.value) })}
                />
              </div>
            )}

            {borrador.strategy === 'fixed' && (
              <div>
                <Label htmlFor="fijo">Monto por pedido</Label>
                <Input
                  id="fijo" type="number" min={0} step="0.01" className="mt-1"
                  value={borrador.fixed_amount ?? ''}
                  onChange={e => setBorrador({ ...borrador, fixed_amount: Number(e.target.value) })}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="min">Mínimo</Label>
                <Input
                  id="min" type="number" min={0} step="0.01" className="mt-1" placeholder="sin mínimo"
                  value={borrador.min_amount ?? ''}
                  onChange={e => setBorrador({
                    ...borrador,
                    min_amount: e.target.value === '' ? null : Number(e.target.value),
                  })}
                />
              </div>
              <div>
                <Label htmlFor="max">Máximo</Label>
                <Input
                  id="max" type="number" min={0} step="0.01" className="mt-1" placeholder="sin máximo"
                  value={borrador.max_amount ?? ''}
                  onChange={e => setBorrador({
                    ...borrador,
                    max_amount: e.target.value === '' ? null : Number(e.target.value),
                  })}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              El <strong>máximo</strong> protege a un negocio de mucho volumen. El <strong>mínimo</strong> nos
              protege a nosotros: cada pedido cuesta mensajes de WhatsApp.
            </p>

            {/* ── El simulador (§42) ───────────────────────────────────── */}
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Calculator className="h-3.5 w-3.5" /> Antes de activarla
              </p>
              <Label htmlFor="sim" className="text-xs">Un pedido de</Label>
              <Input
                id="sim" type="number" min={0} step="0.01" className="mt-1"
                value={subtotal}
                onChange={e => setSubtotal(Number(e.target.value))}
              />
              {!listaParaSimular || simulacion.isError
                ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Completa la regla para ver cuánto dejaría.
                  </p>
                )
                : simulacion.data && (
                  <dl className="mt-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">El cliente paga</dt>
                      <dd className="font-medium tabular-nums text-foreground">
                        {dinero(simulacion.data.customerSubtotal)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">El comercio recibe</dt>
                      <dd className="font-medium tabular-nums text-foreground">
                        {dinero(simulacion.data.merchantSubtotal)}
                      </dd>
                    </div>
                    <div className="flex justify-between border-t border-border pt-1">
                      <dt className="font-medium text-foreground">Nosotros ganamos</dt>
                      <dd className="font-bold tabular-nums text-primary">
                        {dinero(simulacion.data.markup)}
                      </dd>
                    </div>
                  </dl>
                )}
            </div>

            <Button
              className="w-full"
              disabled={guardar.isPending}
              onClick={() => guardar.mutate()}
            >
              <span className="inline-flex items-center gap-1.5">
                <Plus className="h-4 w-4" />
                {guardar.isPending ? 'Guardando…' : reemplazando ? 'Reemplazar' : 'Activar la regla'}
              </span>
            </Button>
            {reemplazando && (
              <Button variant="ghost" className="w-full" onClick={() => setReemplazando(null)}>
                Cancelar
              </Button>
            )}
          </div>
        </Card>
      </div>

      {archivadas.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Reglas archivadas ({archivadas.length}) — se conservan porque los pedidos cobrados apuntan a ellas
          </summary>
          <div className="mt-2 space-y-1">
            {archivadas.map(r => (
              <p key={r.id} className="text-xs text-muted-foreground">
                {r.businesses?.name || r.target_name || ETIQUETA_AMBITO[r.scope]} · v{r.version} · {comoCobra(r)}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
