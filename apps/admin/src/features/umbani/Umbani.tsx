import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Compass, Search, TrendingDown } from 'lucide-react'
import { getMarketplaceUsage } from '../clients/api'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Badge } from '@botpanel/ui/components/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'

// ══════════════════════════════════════════════════════════════════════════
// CÓMO USA LA GENTE EL MENÚ DE UMBANI
//
// Las tres preguntas del dueño (2026-09-18), en el orden en que se responden:
//   1. ¿Dónde se cae la gente? → el embudo.
//   2. ¿Qué cajón se toca y cuál se abandona? → los nombres que hay que afinar.
//   3. ¿Qué escribe, y qué no encuentra? → los alias y los locales que faltan.
//
// ⚠️ El registro empezó el 2026-09-18. Antes de esa fecha no hay nada y no se
// puede inventar hacia atrás: la pantalla lo DICE en vez de enseñar ceros que
// se leerían como «nadie entró».
// ══════════════════════════════════════════════════════════════════════════

const PERIODOS = [
  { dias: 7, label: '7 días' },
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
] as const

const porcentaje = (parte: number, total: number) => (
  total > 0 ? Math.round((parte / total) * 100) : 0
)

export default function Umbani() {
  const [dias, setDias] = useState<number>(7)
  const uso = useQuery({
    queryKey: ['marketplace-usage', dias],
    queryFn: () => getMarketplaceUsage(dias),
  })

  const embudo = uso.data?.embudo ?? []
  const cajones = uso.data?.cajones ?? []
  const busquedas = uso.data?.busquedas ?? []
  const entraron = embudo[0]?.clientes ?? 0
  const vacio = !uso.isLoading && !uso.error && entraron === 0 && !busquedas.length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Compass className="size-5" /> Uso de Umbani
          </h1>
          <p className="text-sm text-muted-foreground">
            Qué hace la gente cuando escribe al número de la plataforma.
          </p>
        </div>
        <div className="flex gap-1">
          {PERIODOS.map(periodo => (
            <Button
              key={periodo.dias}
              size="sm"
              variant={dias === periodo.dias ? 'default' : 'outline'}
              onClick={() => setDias(periodo.dias)}
            >
              {periodo.label}
            </Button>
          ))}
        </div>
      </div>

      {uso.isLoading && <Skeleton className="h-64 w-full" />}
      {uso.error && <QueryError onRetry={() => { void uso.refetch() }} />}

      {vacio && (
        <Card className="p-6 text-sm text-muted-foreground">
          Todavía no hay movimiento en este periodo. El registro empezó el 18 de
          septiembre de 2026: lo anterior no existe y no se puede reconstruir.
        </Card>
      )}

      {!uso.isLoading && !uso.error && !vacio && (
        <>
          {/* 1. Dónde se cae la gente. Cada paso se mide contra el PRIMERO,
              que es la pregunta real: de los que escribieron, ¿cuántos
              llegaron hasta aquí? */}
          <Card className="p-4">
            <h2 className="font-medium mb-3">El camino, paso a paso</h2>
            <div className="space-y-2">
              {embudo.map((paso) => {
                const pct = porcentaje(paso.clientes, entraron)
                return (
                  <div key={paso.paso} data-testid={`paso-${paso.orden}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="capitalize">{paso.paso}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {paso.clientes} {entraron > 0 && `· ${pct}%`}
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-muted">
                      <div className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Cuenta personas distintas, no toques: quien recorre cinco cajones
              es una persona buscando, no cinco.
            </p>
          </Card>

          {/* 2. El cajón que se toca y se abandona: el nombre promete algo que
              adentro no está. */}
          <Card className="p-4">
            <h2 className="font-medium mb-3 flex items-center gap-2">
              <TrendingDown className="size-4" /> Cajones del menú
            </h2>
            {cajones.length === 0
              ? <p className="text-sm text-muted-foreground">Nadie entró a un cajón en este periodo.</p>
              : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cajón</TableHead>
                        <TableHead className="text-right">Entradas</TableHead>
                        <TableHead className="text-right">Eligieron local</TableHead>
                        <TableHead className="text-right">Se fueron</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cajones.map(cajon => (
                        <TableRow key={cajon.code}>
                          <TableCell>{cajon.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{cajon.entradas}</TableCell>
                          <TableCell className="text-right tabular-nums">{cajon.eligieron}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {cajon.abandonaron}
                            {cajon.entradas > 0 && cajon.abandonaron / cajon.entradas > 0.5 && (
                              <Badge variant="secondary" className="ml-2">revisar nombre</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
          </Card>

          {/* 3. Lo que escribe la gente. Las que no encontraron nada van
              primero porque son las accionables. */}
          <Card className="p-4">
            <h2 className="font-medium mb-3 flex items-center gap-2">
              <Search className="size-4" /> Lo que escriben
            </h2>
            {busquedas.length === 0
              ? <p className="text-sm text-muted-foreground">Nadie buscó por texto en este periodo.</p>
              : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Escribió</TableHead>
                        <TableHead className="text-right">Veces</TableHead>
                        <TableHead>Qué pasó</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {busquedas.map(busqueda => (
                        <TableRow key={busqueda.consulta}>
                          <TableCell className="max-w-[16rem] truncate">{busqueda.consulta}</TableCell>
                          <TableCell className="text-right tabular-nums">{busqueda.veces}</TableCell>
                          <TableCell className="text-sm">
                            {busqueda.sin_nada === 0
                              ? <span className="text-muted-foreground">Encontró locales</span>
                              : busqueda.entendido
                                ? <span>Se entendió <b>{busqueda.entendido}</b> y no hay local — falta darlo de alta</span>
                                : <span>No se entendió — le falta un alias o un cajón mejor nombrado</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
          </Card>
        </>
      )}
    </div>
  )
}
