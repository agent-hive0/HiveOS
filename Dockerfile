# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

# ---------------------------------------------------------------------------
# Bundled-engine source images (Hive combined colony image, hive-bootstrap-v3)
#
# The colony runs Paperclip + Sim (Workflows) + the Hive memory sidecar +
# the Hermes agent CLI as ONE image / ONE Fly machine, several processes.
# We pull Sim's prebuilt, published images and the sidecar image and COPY
# their artifacts in — same proven pattern Paperclip already relies on for
# the sidecar. No from-source Sim build (avoids the 60-min CI cap).
#
# NOTE: realtime + migrations images are Alpine (musl); the app image is
# Debian (glibc), same libc family as this colony base. We therefore use
# the APP image's `bun` (glibc) to run all three — realtime/migrations are
# pure-JS so their musl-installed node_modules load fine under glibc bun.
# ---------------------------------------------------------------------------
FROM ghcr.io/simstudioai/simstudio:latest AS sim_app
FROM ghcr.io/simstudioai/realtime:latest AS sim_realtime
FROM ghcr.io/simstudioai/migrations:latest AS sim_migrations
FROM ghcr.io/agent-hive0/hive-colony-sidecar:v0.1.2 AS hive_sidecar

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# --- Bundled engines: runtime deps -----------------------------------------
# pgvector-capable Postgres (Sim + memory both need the `vector` extension;
# Paperclip's embedded PG has no pgvector). Installed from the PGDG apt repo
# so the `postgresql-17-pgvector` package is guaranteed present. ffmpeg +
# python venv are Sim app runtime deps; pip is for the Hermes agent CLI.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3-pip python3-venv gnupg postgresql-common \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-17 postgresql-17-pgvector postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

# Hermes agent CLI. The fork already wires the `hermes_local` adapter
# (server/src/adapters/registry.ts) + ships hermes-paperclip-adapter as a
# server dep; the adapter spawns this CLI as a subprocess. Always present,
# no enable flag.
RUN pip3 install --no-cache-dir --break-system-packages hermes-agent

# Sim runtime: one glibc `bun` from the app image runs app + realtime +
# migrations. Bring in each prebuilt tree.
COPY --from=sim_app /usr/local/bin/bun /usr/local/bin/bun
COPY --from=sim_app --chown=node:node /app /opt/hive-sim/app
COPY --from=sim_realtime --chown=node:node /app /opt/hive-sim/realtime
COPY --from=sim_migrations --chown=node:node /app /opt/hive-sim/migrations

# Hive memory sidecar (same artifact the sidecar-only image ships).
COPY --from=hive_sidecar --chown=node:node /sidecar /opt/hive-colony-sidecar

COPY scripts/docker-entrypoint.sh scripts/hive-engines.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/hive-engines.sh

# Pin npm / npx / pnpm caches to ephemeral overlay disk so they never
# accumulate on the persistent /paperclip volume. (See incident
# 2026-05-11: 745 MB of _cacache + _npx filled a 1 GB volume and took
# the colony's DB offline.)
ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  npm_config_cache=/tmp/npm-cache \
  NPM_CONFIG_CACHE=/tmp/npm-cache \
  NPM_CONFIG_PREFER_OFFLINE=true \
  PNPM_HOME=/tmp/pnpm-home \
  XDG_CACHE_HOME=/tmp/cache

VOLUME ["/paperclip"]
# 3100 Paperclip · 3000 Sim app · 3002 Sim realtime · 3101 memory sidecar
EXPOSE 3100 3000 3002 3101

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
