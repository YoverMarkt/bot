#!/usr/bin/env bash
# Corre la misma verificación del CI contra un PostgreSQL local en Docker.
#
# Levanta una base vacía, le aplica el bootstrap de Supabase y schema.sql, y
# ejecuta las funciones críticas. Después comprueba que la verificación DETECTA
# un esquema roto: una verificación que no detecta nada sería peor que ninguna.
#
#   bash server/tests/sql/verificar-en-docker.sh
#
# Requiere Docker corriendo. No toca ninguna base real.
set -euo pipefail

CONTENEDOR=botpanel-verificacion-esquema
IMAGEN=pgvector/pgvector:pg16
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$(cd "$AQUI/../.." && pwd)"

limpiar() { docker rm -f "$CONTENEDOR" >/dev/null 2>&1 || true; }
trap limpiar EXIT

psql_() { docker exec -i "$CONTENEDOR" psql -U postgres -d botpanel -v ON_ERROR_STOP=1 "$@"; }

echo "🐘 Levantando PostgreSQL de prueba…"
limpiar
docker run -d --name "$CONTENEDOR" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=botpanel "$IMAGEN" >/dev/null
until docker exec "$CONTENEDOR" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

echo "🔧 Emulando el entorno de Supabase…"
psql_ -q < "$AQUI/bootstrap-supabase.sql"

echo "📐 Aplicando schema.sql en una base vacía…"
psql_ -q < "$SERVER/schema.sql"

echo "🧪 Ejecutando las funciones críticas…"
psql_ < "$AQUI/verificar-esquema.sql"

echo "🔍 Comprobando que la verificación detecta un esquema roto…"
psql_ -q -c \
  "alter function public.record_inbound_message_usage() set search_path = public, pg_temp;"
if psql_ -q < "$AQUI/verificar-esquema.sql" >/dev/null 2>&1; then
  echo "❌ La verificación pasó con el esquema roto: ya no detecta nada"
  exit 1
fi

echo
echo "✅ Esquema verificado contra PostgreSQL real"
