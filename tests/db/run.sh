#!/usr/bin/env bash
# Builds a fresh database exactly like a new deployment (schema -> seed ->
# every migration in order) and runs the assertion tests in tests/db.
# Needs psql and a PostgreSQL 16 server; connection via the usual PG* env
# vars (PGHOST, PGPORT, PGUSER, PGPASSWORD). Usage: tests/db/run.sh [dbname]
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${1:-salon_test}"
PSQL=(psql -v ON_ERROR_STOP=1 -q -X)

"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB"
"${PSQL[@]}" -d postgres -c "alter database $DB set app.base_url = 'https://salon.example'"
run() { echo "  · $1"; PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$DB" -f "$1" > /dev/null; }

run tests/db/00_supabase_stub.sql
case "${MODE:-files}" in
  files)    # every file separately, like following DEPLOY.md by hand
    echo "== schema, seed, migrations (file by file)"
    run supabase/schema.sql
    run supabase/seed.sql
    for f in $(ls supabase/migrations/v2.*.sql | sort -V); do run "$f"; done ;;
  bundle)   # the paste-ready fresh-install bundle, as ONE transaction
    echo "== supabase/deploy/full_install.sql (single transaction)"
    PSQL+=(-1); run supabase/deploy/full_install.sql; PSQL=("${PSQL[@]:0:4}") ;;
  upgrade)  # an existing v2.27 install, then the upgrade bundle in ONE transaction
    echo "== v2.27 install, then supabase/deploy/upgrade_v2.28_to_latest.sql"
    run supabase/schema.sql
    run supabase/seed.sql
    for f in $(ls supabase/migrations/v2.*.sql | sort -V | awk -F'v2.' '{split($2,a,"_"); if (a[1]+0 < 28) print}'); do run "$f"; done
    PSQL+=(-1); run supabase/deploy/upgrade_v2.28_to_latest.sql; PSQL=("${PSQL[@]:0:4}") ;;
esac

echo "== tests"
run tests/db/01_helpers.sql
run tests/db/02_fixtures.sql
for t in tests/db/test_*.sql; do run "$t"; done
echo "== all DB tests passed"
