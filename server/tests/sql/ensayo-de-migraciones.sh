#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# EL ENSAYO: aplicar lo PENDIENTE en el orden real, sobre el esquema anterior
#
# El CI aplica `schema.sql` entero sobre una base vacía. Eso NUNCA reproduce la
# cadena de migraciones, así que sale verde sobre una ficción: una migración
# que depende de otra del mismo día puede ordenar antes que ella y nadie se
# entera hasta que se aplica contra producción.
#
# Ha pasado DOS veces:
#   · 2026-08-20: `retirar-citas` corrió antes que `retirar-hospedaje`, que
#     recreaba el onboarding con una columna que citas ya había soltado.
#   · 2026-08-21: `busqueda-del-marketplace` ordenaba antes que
#     `categorias-del-marketplace`, de la que depende por una foránea. Habría
#     fallado con «relation public.marketplace_categories does not exist».
#
# Esto lo caza: parte del `schema.sql` de un commit ANTERIOR —el que refleja lo
# que hay aplicado hoy— y aplica las migraciones pendientes en el mismo orden
# que usa `tests/migraciones.mjs`: alfabético, con las fechadas al final.
#
#   bash server/tests/sql/ensayo-de-migraciones.sh <commit-base> <migración…>
#
# Ejemplo, antes de aplicar lo de hoy a producción:
#   bash server/tests/sql/ensayo-de-migraciones.sh 6d7aa95 \
#     server/migration-2026-08-21-*.sql
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

BASE="${1:?Falta el commit cuyo schema.sql refleja lo YA aplicado}"
shift
[ "$#" -gt 0 ] || { echo "Falta al menos una migración pendiente"; exit 1; }

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../../.." && pwd)"
CONTENEDOR="umbani-ensayo-$$"

limpiar() { docker rm -f "$CONTENEDOR" >/dev/null 2>&1 || true; }
trap limpiar EXIT

echo "🐳 Levantando PostgreSQL…"
docker run -d --name "$CONTENEDOR" -e POSTGRES_PASSWORD=probar \
  -e POSTGRES_DB=probar pgvector/pgvector:pg16 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTENEDOR" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

psql_() { docker exec -i "$CONTENEDOR" psql -U postgres -d botpanel -v ON_ERROR_STOP=1 "$@"; }
docker exec -i "$CONTENEDOR" psql -U postgres -d postgres -q -c "create database botpanel;" >/dev/null
psql_ -q < "$AQUI/bootstrap-supabase.sql"

echo "📐 Sembrando el esquema de $BASE (lo que hay aplicado hoy)…"
git -C "$RAIZ" show "$BASE:server/schema.sql" | psql_ -q >/dev/null 2>&1

echo ""
echo "🚚 Aplicando lo pendiente en el ORDEN DEL EJECUTOR:"
fallo=0
# Mismo criterio que `tests/migraciones.mjs`: alfabético.
for archivo in $(printf '%s\n' "$@" | sort); do
  nombre="$(basename "$archivo")"
  printf '   %-58s ' "$nombre"
  # ⚠️ Un archivo que no existe tiene que FALLAR, no pasar. `cat` de algo
  # inexistente deja la entrada vacía y psql la acepta encantado: el ensayo
  # decía ✅ sobre una migración que no había leído. Lo descubrí probando el
  # propio guardián, que es para lo que sirve probarlos.
  if [ ! -f "$RAIZ/$archivo" ]; then
    echo "❌ no existe"
    fallo=1
    continue
  fi
  # Cada una en su transacción, igual que el ejecutor.
  if { echo "begin;"; cat "$RAIZ/$archivo"; echo "commit;"; } \
      | docker exec -i "$CONTENEDOR" psql -U postgres -d botpanel \
        -v ON_ERROR_STOP=1 -q >/dev/null 2>/tmp/ensayo-error.txt; then
    echo "✅"
  else
    echo "❌"
    grep -i '^ERROR' /tmp/ensayo-error.txt | head -3 | sed 's/^/        /'
    fallo=1
  fi
done

echo ""
if [ "$fallo" -eq 0 ]; then
  echo "✅ Las migraciones pendientes se aplican en su orden real."
  echo "   Ojo: esto comprueba que NO REVIENTAN. Que hagan lo correcto lo"
  echo "   comprueba verificar-en-docker.sh."
else
  echo "❌ El orden real ROMPE. No apliques esto a producción."
  echo "   Suele ser una migración que depende de otra del mismo día y ordena"
  echo "   antes que ella: renómbrala para que ordene después."
  exit 1
fi
