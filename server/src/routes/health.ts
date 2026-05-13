import { timingSafeEqual } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

function hasDevServerStatusToken(providedToken: string | undefined) {
  const expectedToken = process.env.PAPERCLIP_DEV_SERVER_STATUS_TOKEN?.trim();
  const token = providedToken?.trim();
  if (!expectedToken || !token) return false;

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}


/**
 * Snapshot of disk/memory/CPU pressure for this colony's VM.
 * Disk uses statfsSync on the persistent volume mount (defaults to
 * /paperclip; override with PAPERCLIP_DATA_DIR). Memory prefers
 * /proc/meminfo (Linux containers) and falls back to os.totalmem()/
 * freemem(). CPU is the 1-minute load average vs cpus().length.
 *
 * Everything is best-effort: any failure produces a null value so the
 * dashboard can show "unavailable" without 500-ing the whole health
 * endpoint.
 */
function collectResourceSnapshot() {
  const mountPath = process.env.PAPERCLIP_DATA_DIR?.trim() || "/paperclip";

  let disk: {
    mount: string;
    bytes_total: number;
    bytes_used: number;
    bytes_free: number;
    used_pct: number;
  } | null = null;
  try {
    const stat = statfsSync(mountPath);
    const blockSize = stat.bsize;
    const total = Number(stat.blocks) * blockSize;
    const free = Number(stat.bavail) * blockSize;
    const used = total - free;
    disk = {
      mount: mountPath,
      bytes_total: total,
      bytes_used: used,
      bytes_free: free,
      used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch {
    disk = null;
  }

  let memory: {
    bytes_total: number;
    bytes_used: number;
    bytes_free: number;
    used_pct: number;
  } | null = null;
  try {
    let total = totalmem();
    let available = freemem();
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      const totalLine = /MemTotal:\s+(\d+)\s+kB/.exec(meminfo);
      const availLine = /MemAvailable:\s+(\d+)\s+kB/.exec(meminfo);
      if (totalLine && availLine) {
        total = Number(totalLine[1]) * 1024;
        available = Number(availLine[1]) * 1024;
      }
    } catch {
      // /proc/meminfo unavailable (e.g. macOS dev) — keep os.*mem() values
    }
    const used = Math.max(0, total - available);
    memory = {
      bytes_total: total,
      bytes_used: used,
      bytes_free: available,
      used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    };
  } catch {
    memory = null;
  }

  let cpu: {
    cores: number;
    load_1m: number;
    load_5m: number;
    load_15m: number;
    load_1m_per_core: number;
  } | null = null;
  try {
    const cores = cpus()?.length ?? 1;
    const [m1, m5, m15] = loadavg();
    cpu = {
      cores,
      load_1m: Math.round(m1 * 100) / 100,
      load_5m: Math.round(m5 * 100) / 100,
      load_15m: Math.round(m15 * 100) / 100,
      load_1m_per_core: cores > 0 ? Math.round((m1 / cores) * 1000) / 10 : 0,
    };
  } catch {
    cpu = null;
  }

  return { disk, memory, cpu, sampledAt: new Date().toISOString() };
}

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );
    const exposeDevServerDetails =
      exposeFullDetails || hasDevServerStatusToken(req.get("x-paperclip-dev-server-status-token"));

    if (!db) {
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable"
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (exposeDevServerDetails && persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        bootstrapStatus,
        bootstrapInviteActive,
        resources: collectResourceSnapshot(),
        ...(devServer ? { devServer } : {}),
      });
      return;
    }

    const resources = collectResourceSnapshot();

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      resources,
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
