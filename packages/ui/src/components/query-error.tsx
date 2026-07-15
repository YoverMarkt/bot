import { CircleAlert, RotateCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "./alert"
import { Button } from "./button"

type QueryErrorProps = {
  message?: string
  onRetry?: () => void
}

function QueryError({
  message = "No pudimos cargar la información. Revisa tu conexión e inténtalo otra vez.",
  onRetry,
}: QueryErrorProps) {
  return (
    <Alert variant="destructive" className="my-4">
      <CircleAlert />
      <AlertTitle>Error al cargar</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{message}</span>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RotateCw /> Reintentar
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export { QueryError }
