#!/bin/sh
# hive-engines.sh — start the colony's bundled engines.
#
# Hive ships Paperclip + Sim (Workflows) + the memory sidecar + the Hermes
# agent CLI as ONE image / ONE Fly machine. This script is invoked by
# docker-entrypoint.sh (as root, just before it execs Paperclip as `node`).
# It:
#   1. auto-generates + persists Sim's secrets to the /paperclip volume
#      (no operator env, no enable flags — "just works")
#   2. starts a pgvector-capable Postgres on the volume (Sim + memory both
#      need the `vector` extension; Paperclip's embedded PG has none)
#   3. runs Sim's drizzle migrations against the `sim` database
#   4. forks Sim app (:3000), Sim realtime (:3002), and the memory
#      sidecar (:3101) as background children
#
# Everything is best-effort: a failure here NEVER aborts Paperclip boot.
# Children inherit stdout/stderr so their logs land in `fly logs`.

log() { echo "[hive-engines $(date -u +%FT%TZ)] $*"; }

PG_BIN=/usr/lib/postgresql/17/bin
PGDATA=/paperclip/sim-pg/data
PG_PORT=5433
PG_HOST=127.0.0.1
PG_SUPERUSER=hive
SECRETS_FILE=/paperclip/secrets/sim.env
BUN=/usr/local/bin/bun

# Sim's public origin (cookies / CSP / client config). The colony's public
# URL is the closest correct value; refine per-engine routing later.
SIM_PUBLIC_URL="${PAPERCLIP_AUTH_PUBLIC_BASE_URL:-http://127.0.0.1:3000}"

run_node() { gosu node "$@"; }
psql_super() { gosu node "$PG_BIN/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" "$@"; }

# --- 1. secrets (generate once, persist, reuse) ----------------------------
gen_hex() { run_node node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }

if [ ! -f "$SECRETS_FILE" ]; then
    log "generating Sim secrets -> $SECRETS_FILE (first boot)"
    mkdir -p /paperclip/secrets
    {
        echo "SIM_BETTER_AUTH_SECRET=$(gen_hex)"
        echo "SIM_ENCRYPTION_KEY=$(gen_hex)"
        echo "SIM_INTERNAL_API_SECRET=$(gen_hex)"
        echo "SIM_API_ENCRYPTION_KEY=$(gen_hex)"
    } > "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"
    chown node:node "$SECRETS_FILE" 2>/dev/null || true
fi
# shellcheck disable=SC1090
. "$SECRETS_FILE"

# --- 2. pgvector Postgres on the volume ------------------------------------
mkdir -p /paperclip/sim-pg
chown -R node:node /paperclip/sim-pg 2>/dev/null || true

if [ ! -f "$PGDATA/PG_VERSION" ]; then
    log "initdb pgvector Postgres at $PGDATA"
    run_node "$PG_BIN/initdb" -D "$PGDATA" -U "$PG_SUPERUSER" \
        --auth-local=trust --auth-host=trust --encoding=UTF8 >/dev/null 2>&1 \
        || { log "ERROR initdb failed — Sim/memory will be unavailable"; return 0 2>/dev/null || exit 0; }
fi

log "starting pgvector Postgres on $PG_HOST:$PG_PORT"
run_node "$PG_BIN/pg_ctl" -D "$PGDATA" -l /paperclip/sim-pg/server.log -w -t 60 \
    -o "-p $PG_PORT -c listen_addresses=$PG_HOST -k /tmp" start \
    || log "WARN pg_ctl start returned non-zero (may already be running)"

# Wait for readiness (up to ~30s).
i=0
while [ "$i" -lt 30 ]; do
    if run_node "$PG_BIN/pg_isready" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" >/dev/null 2>&1; then
        break
    fi
    i=$((i + 1)); sleep 1
done
if ! run_node "$PG_BIN/pg_isready" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" >/dev/null 2>&1; then
    log "ERROR pgvector Postgres not ready after 30s — skipping Sim/memory startup"
    return 0 2>/dev/null || exit 0
fi

# Databases + extension (idempotent). `sim` for Sim, `hive_app` for memory.
for db in sim hive_app; do
    exists=$(psql_super -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" 2>/dev/null)
    if [ "$exists" != "1" ]; then
        log "creating database $db"
        gosu node "$PG_BIN/createdb" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" "$db" \
            || log "WARN could not create $db"
    fi
    psql_super -d "$db" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null 2>&1 \
        || log "WARN could not create vector extension in $db"
done

SIM_DB_URL="postgresql://$PG_SUPERUSER@$PG_HOST:$PG_PORT/sim"
HIVE_APP_DB_URL="postgresql://$PG_SUPERUSER@$PG_HOST:$PG_PORT/hive_app"

# --- 3. Sim migrations (blocking, non-fatal) -------------------------------
if [ -d /opt/hive-sim/migrations/packages/db ]; then
    log "running Sim migrations"
    ( cd /opt/hive-sim/migrations/packages/db \
        && DATABASE_URL="$SIM_DB_URL" gosu node "$BUN" run ./scripts/migrate.ts ) \
        || log "WARN Sim migrations failed (continuing — app may self-heal)"
fi

# --- 4. fork engines -------------------------------------------------------
# Sim app (:3000)
if [ -f /opt/hive-sim/app/apps/sim/server.js ]; then
    log "starting Sim app on :3000"
    ( cd /opt/hive-sim/app \
        && DATABASE_URL="$SIM_DB_URL" \
           BETTER_AUTH_SECRET="$SIM_BETTER_AUTH_SECRET" \
           BETTER_AUTH_URL="$SIM_PUBLIC_URL" \
           NEXT_PUBLIC_APP_URL="$SIM_PUBLIC_URL" \
           ENCRYPTION_KEY="$SIM_ENCRYPTION_KEY" \
           INTERNAL_API_SECRET="$SIM_INTERNAL_API_SECRET" \
           API_ENCRYPTION_KEY="$SIM_API_ENCRYPTION_KEY" \
           PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production \
           SOCKET_SERVER_URL="http://127.0.0.1:3002" \
           gosu node "$BUN" apps/sim/server.js ) &
    log "Sim app pid $!"
else
    log "WARN Sim app server.js missing — skipping"
fi

# Sim realtime (:3002)
if [ -f /opt/hive-sim/realtime/apps/realtime/src/index.ts ]; then
    log "starting Sim realtime on :3002"
    ( cd /opt/hive-sim/realtime \
        && DATABASE_URL="$SIM_DB_URL" \
           BETTER_AUTH_SECRET="$SIM_BETTER_AUTH_SECRET" \
           BETTER_AUTH_URL="$SIM_PUBLIC_URL" \
           NEXT_PUBLIC_APP_URL="$SIM_PUBLIC_URL" \
           INTERNAL_API_SECRET="$SIM_INTERNAL_API_SECRET" \
           PORT=3002 HOSTNAME=0.0.0.0 NODE_ENV=production \
           gosu node "$BUN" apps/realtime/src/index.ts ) &
    log "Sim realtime pid $!"
else
    log "WARN Sim realtime index.ts missing — skipping"
fi

# Memory sidecar (:3101) — points at the pgvector `hive_app` DB.
SIDECAR_CLI=/opt/hive-colony-sidecar/packages/colony-sidecar/dist/cli.js
if [ -f "$SIDECAR_CLI" ]; then
    log "starting memory sidecar on :3101"
    ( cd /opt/hive-colony-sidecar \
        && DATABASE_URL="$HIVE_APP_DB_URL" \
           PORT=3101 NODE_ENV=production \
           gosu node node --enable-source-maps "$SIDECAR_CLI" ) &
    log "memory sidecar pid $!"
else
    log "WARN memory sidecar cli.js missing — skipping"
fi

log "engine startup dispatched"
