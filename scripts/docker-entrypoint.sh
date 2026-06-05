#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# Fly.io and other platforms mount volumes as root-owned by default.
# Ensure /paperclip is writable by the node user even when UID/GID didn't change.
if [ -d /paperclip ] && [ "$(stat -c '%u' /paperclip)" != "$(id -u node)" ]; then
    echo "Fixing /paperclip ownership for node user"
    chown -R node:node /paperclip
fi

# Stage ephemeral cache dirs on overlay disk so npm/npx/pnpm never
# touch the persistent /paperclip volume. Matches the ENV pins in the
# Dockerfile (npm_config_cache, PNPM_HOME, XDG_CACHE_HOME).
for d in /tmp/npm-cache /tmp/pnpm-home /tmp/cache; do
    mkdir -p "$d"
    chown node:node "$d" 2>/dev/null || true
done

# Self-heal: scrub leftover npm/npx caches that older image versions
# wrote onto the persistent volume. Safe to delete — they're throwaway
# package caches, not state. Idempotent + bounded so we don't run
# every minute: only if any cache dir exists.
if [ -d /paperclip/.npm/_cacache ] || [ -d /paperclip/.npm/_npx ] || [ -d /paperclip/.cache/node ]; then
    echo "Pruning legacy npm/npx caches from persistent volume"
    rm -rf /paperclip/.npm/_cacache /paperclip/.npm/_npx /paperclip/.npm/_logs /paperclip/.cache/node 2>/dev/null || true
fi

# ------------------------------------------------------------------
# Pre-flight checks. Each check writes one line to /paperclip/preflight.log
# and either fixes the problem or exits non-zero with a clear reason.
# The goal: if the server is going to fail to boot, fail HERE so the
# log line is the actual cause — not 10 rounds of "main child exited".
# ------------------------------------------------------------------
PREFLIGHT_LOG=/paperclip/preflight.log
mkdir -p /paperclip
: > "$PREFLIGHT_LOG" || true

preflight() {
    echo "[preflight $(date -u +%FT%TZ)] $*" | tee -a "$PREFLIGHT_LOG"
}

# 1) Required secrets. Better-auth refuses to boot without these and the
#    generic "main child exited" log makes it look like a crash loop.
#    Fail fast with a specific message a customer-visible health check
#    can read back through /api/internal/preflight.
MISSING=""
for v in BETTER_AUTH_SECRET HIVE_BOOTSTRAP_SECRET; do
    eval "val=\${$v:-}"
    if [ -z "$val" ]; then
        MISSING="$MISSING $v"
    fi
done
if [ -n "$MISSING" ]; then
    preflight "FATAL missing required env:$MISSING"
    preflight "action: set the secret via \`fly secrets set <KEY>=<VALUE> -a <app>\` and \`fly secrets deploy\`"
    # Sleep before exit so Fly's restart-loop back-off (8s, 16s, ...) gives
    # the operator time to see the log without the machine churning.
    sleep 30
    exit 78  # EX_CONFIG
fi

# 2) Disk headroom. Embedded Postgres needs ~50 MB free to start;
#    growing WAL needs more. Anything <100 MB free is a recipe for
#    "could not write lock file: No space left on device" and a
#    10-restart-cap death spiral.
if command -v df >/dev/null 2>&1; then
    # df -B1 gives bytes; the 4th column is Available.
    AVAIL_BYTES=$(df -B1 /paperclip 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -n "$AVAIL_BYTES" ] && [ "$AVAIL_BYTES" -lt 104857600 ]; then
        preflight "FATAL only ${AVAIL_BYTES} bytes free on /paperclip (<100 MB)"
        preflight "action: \`fly volume extend <vol-id> -s <bigger-gb> -a <app>\` then restart machine"
        sleep 30
        exit 78
    fi
    # Warning band: < 20% free — boot but flag it in the log so the
    # vitals collector picks it up immediately.
    TOTAL_BYTES=$(df -B1 /paperclip 2>/dev/null | awk 'NR==2 {print $2}')
    if [ -n "$AVAIL_BYTES" ] && [ -n "$TOTAL_BYTES" ] && [ "$TOTAL_BYTES" -gt 0 ]; then
        USED_PCT=$(( (TOTAL_BYTES - AVAIL_BYTES) * 100 / TOTAL_BYTES ))
        if [ "$USED_PCT" -ge 80 ]; then
            preflight "WARN /paperclip is ${USED_PCT}% full (extend the volume before it hits 95%)"
        else
            preflight "ok disk ${USED_PCT}% used"
        fi
    fi
fi

# 3) Postgres data dir sanity. If the directory exists but PG_VERSION is
#    missing, embedded-postgres will re-init and silently wipe what's
#    there. Better to refuse and let an operator decide.
PG_DATA_DIR=/paperclip/instances/${PAPERCLIP_INSTANCE_ID:-default}/db
if [ -d "$PG_DATA_DIR" ] && [ "$(ls -A "$PG_DATA_DIR" 2>/dev/null | head -1)" ] && [ ! -f "$PG_DATA_DIR/PG_VERSION" ]; then
    preflight "FATAL $PG_DATA_DIR has files but no PG_VERSION — refusing to re-init (data loss risk)"
    preflight "action: investigate /paperclip from an SSH session before restarting"
    sleep 30
    exit 70  # EX_SOFTWARE
fi
preflight "ok pre-flight passed"

# ------------------------------------------------------------------
# Bundled engines (Sim Workflows + Hive memory sidecar). Always-on —
# no enable flags. hive-engines.sh starts a pgvector Postgres on the
# volume, runs Sim migrations, and forks Sim app/realtime + the memory
# sidecar as background children that survive the exec below. Any
# failure is NON-FATAL: Paperclip must still boot even if an engine
# can't start, so the colony degrades gracefully instead of crash-
# looping. (Hermes needs no process here — it's a Paperclip adapter
# that spawns the `hermes` CLI on demand.)
# ------------------------------------------------------------------
if [ -x /usr/local/bin/hive-engines.sh ]; then
    /usr/local/bin/hive-engines.sh || preflight "WARN hive-engines returned non-zero — engines degraded, Paperclip continuing"
fi

exec gosu node "$@"
