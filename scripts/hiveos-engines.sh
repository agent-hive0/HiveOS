#!/bin/sh
# hiveos-engines.sh — start the colony's bundled engines for the `hiveos`
# combined image (Paperclip + from-source EMBEDDABLE Sim + Hermes + Memory).
#
# Invoked by docker-entrypoint.sh (as root) just before it execs Paperclip as
# `node`. Mirrors the v3 `hive-engines.sh` but targets the FROM-SOURCE Sim
# layout (standalone Next output under /opt/hive-sim) and wires the Sim embed
# (handoff token + frame-ancestors). Everything is best-effort: a failure here
# NEVER aborts Paperclip boot.
#
#   1. generate + persist Sim secrets to the /paperclip volume
#   2. start a pgvector Postgres on the volume (Sim + memory need `vector`)
#   3. run Sim's drizzle migrations against the `sim` database
#   4. fork Sim app (:3000, embeddable), Sim realtime (:3002), memory (:3101)

log() { echo "[hiveos-engines $(date -u +%FT%TZ)] $*"; }

PG_BIN=/usr/lib/postgresql/17/bin
PGDATA=/paperclip/sim-pg/data
PG_PORT=5433
PG_HOST=127.0.0.1
PG_SUPERUSER=hive
SECRETS_FILE=/paperclip/secrets/sim.env
BUN=/usr/local/bin/bun

SIM_APP_DIR=/opt/hive-sim
SIM_REALTIME_DIR=/opt/hive-realtime
SIM_MIGRATIONS_DIR=/opt/hive-sim-migrations
SIDECAR_DIR=/opt/hive-colony-sidecar

# Sim's public origin (cookies / CSP / client config).
SIM_PUBLIC_URL="${SIM_PUBLIC_URL:-${PAPERCLIP_AUTH_PUBLIC_BASE_URL:-http://127.0.0.1:3000}}"
# Embed wiring: handoff token defaults to the per-colony proxy token; frame
# ancestors default to the Hive origins so the canvas is Hive-only.
HIVE_SIM_HANDOFF_TOKEN="${HIVE_SIM_HANDOFF_TOKEN:-${HIVE_PROXY_TOKEN:-}}"
SIM_FRAME_ANCESTORS="${SIM_FRAME_ANCESTORS:-https://agenthive.co https://*.agenthive.co}"

run_node() { gosu node "$@"; }
psql_super() { gosu node "$PG_BIN/psql" -h "$PG_HOST" -p "$PG_PORT" -U "$PG_SUPERUSER" "$@"; }
gen_hex() { run_node node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'; }

# --- 1. secrets (generate once, persist, reuse) ----------------------------
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
        || { log "ERROR initdb failed — Sim/memory unavailable"; return 0 2>/dev/null || exit 0; }
fi

log "starting pgvector Postgres on $PG_HOST:$PG_PORT"
run_node "$PG_BIN/pg_ctl" -D "$PGDATA" -l /paperclip/sim-pg/server.log -w -t 60 \
    -o "-p $PG_PORT -c listen_addresses=$PG_HOST -k /tmp" start \
    || log "WARN pg_ctl start returned non-zero (may already be running)"

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
if [ -d "$SIM_MIGRATIONS_DIR/packages/db" ]; then
    log "running Sim migrations"
    ( cd "$SIM_MIGRATIONS_DIR/packages/db" \
        && DATABASE_URL="$SIM_DB_URL" gosu node "$BUN" run db:migrate ) \
        || log "WARN Sim migrations failed (continuing — app may self-heal)"
fi

# --- 4. fork engines -------------------------------------------------------
# Sim app (:3000) — from-source standalone, EMBEDDABLE (handoff + CSP).
if [ -f "$SIM_APP_DIR/apps/sim/server.js" ]; then
    log "starting embeddable Sim app on :3000"
    ( cd "$SIM_APP_DIR" \
        && DATABASE_URL="$SIM_DB_URL" \
           BETTER_AUTH_SECRET="$SIM_BETTER_AUTH_SECRET" \
           BETTER_AUTH_URL="$SIM_PUBLIC_URL" \
           NEXT_PUBLIC_APP_URL="$SIM_PUBLIC_URL" \
           ENCRYPTION_KEY="$SIM_ENCRYPTION_KEY" \
           INTERNAL_API_SECRET="$SIM_INTERNAL_API_SECRET" \
           API_ENCRYPTION_KEY="$SIM_API_ENCRYPTION_KEY" \
           HIVE_SIM_HANDOFF_TOKEN="$HIVE_SIM_HANDOFF_TOKEN" \
           SIM_FRAME_ANCESTORS="$SIM_FRAME_ANCESTORS" \
           SIM_COLONY_HOST="${SIM_COLONY_HOST:-}" \
           PORT=3000 HOSTNAME=0.0.0.0 NODE_ENV=production \
           SOCKET_SERVER_URL="http://127.0.0.1:3002" \
           gosu node "$BUN" apps/sim/server.js ) &
    log "Sim app pid $!"
else
    log "WARN Sim app server.js missing — skipping"
fi

# Sim realtime (:3002)
if [ -f "$SIM_REALTIME_DIR/apps/realtime/src/index.ts" ]; then
    log "starting Sim realtime on :3002"
    ( cd "$SIM_REALTIME_DIR" \
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
SIDECAR_CLI="$SIDECAR_DIR/packages/colony-sidecar/dist/cli.js"
if [ -f "$SIDECAR_CLI" ]; then
    log "starting memory sidecar on :3101"
    ( cd "$SIDECAR_DIR" \
        && DATABASE_URL="$HIVE_APP_DB_URL" \
           HIVE_PROXY_TOKEN="${HIVE_PROXY_TOKEN:-}" \
           PORT=3101 NODE_ENV=production \
           gosu node node --enable-source-maps "$SIDECAR_CLI" ) &
    log "memory sidecar pid $!"
else
    log "WARN memory sidecar cli.js missing — skipping"
fi

log "engine startup dispatched"
