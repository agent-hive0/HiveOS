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

exec gosu node "$@"
