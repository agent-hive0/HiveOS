import { timingSafeEqual } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { serverVersion } from "../version.js";

/**
 * Vitals endpoint for the Hive gateway's colony-vitals collector.
 *
 * Contract: GET /api/v1/health/vitals
 *   Authorization: Bearer <HIVE_BOOTSTRAP_SECRET>
 *   → 200 JSON snapshot of disk/memory/CPU/PG/process state
 *   → 401 if missing/invalid token
 *   → 503 only if the DB probe itself fails (we still try to emit
 *     disk/memory/CPU so the collector can record partial vitals)
 *
 * The gateway polls every 60s. Keep this endpoint cheap (<50ms) — it's
 * the read side of the monitoring story. All "is this colony alive?"
 * decisions in the staff dashboard route through here.
 *
 * The endpoint is mounted at `/api/v1/health/vitals` so we don't have
 * to share the auth-gated company routes' middleware. The route lives
 * in its own router and the only auth is the HIVE_BOOTSTRAP_SECRET
 * header — same secret the provisioner uses to call
 * `/api/access/hive-bootstrap`, so no new key distribution.
 */

function bearerTokenFromHeader(header: string | undefined): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header);
	if (!m) return null;
	return m[1].trim() || null;
}

function constantTimeEqual(a: string, b: string): boolean {
	const aBuf = Buffer.from(a);
	const bBuf = Buffer.from(b);
	if (aBuf.length !== bBuf.length) return false;
	return timingSafeEqual(aBuf, bBuf);
}

function readDisk(mountPath: string) {
	try {
		const stat = statfsSync(mountPath);
		const blockSize = stat.bsize;
		const total = Number(stat.blocks) * blockSize;
		const free = Number(stat.bavail) * blockSize;
		const used = total - free;
		return {
			mount: mountPath,
			total_bytes: total,
			used_bytes: used,
			free_bytes: free,
			used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
		};
	} catch {
		return null;
	}
}

function readMemory() {
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
			// /proc/meminfo unavailable (macOS dev box) — keep os.*mem() values
		}
		const used = Math.max(0, total - available);
		// RSS of *this* node process (the colony server). Useful as a
		// "memory leak in Paperclip itself?" signal vs total VM memory.
		const rss = process.memoryUsage().rss;
		return {
			total_bytes: total,
			used_bytes: used,
			free_bytes: available,
			used_pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
			rss_bytes: rss,
		};
	} catch {
		return null;
	}
}

function readCpu() {
	try {
		const cores = cpus()?.length ?? 1;
		const [m1, m5, m15] = loadavg();
		return {
			cores,
			load_1m: Math.round(m1 * 100) / 100,
			load_5m: Math.round(m5 * 100) / 100,
			load_15m: Math.round(m15 * 100) / 100,
			load_1m_per_core: cores > 0 ? Math.round((m1 / cores) * 1000) / 10 : 0,
		};
	} catch {
		return null;
	}
}

async function readPostgres(db: Db) {
	// All queries are wrapped individually so a permission gap on one
	// stat (e.g. pg_stat_activity on a hardened cluster) doesn't sink
	// the rest of the snapshot.
	let dataBytes: number | null = null;
	let walBytes: number | null = null;
	let connectionCount: number | null = null;
	let oldestQueryAgeSec: number | null = null;

	try {
		const rows = (await db.execute(
			sql`SELECT pg_database_size(current_database())::bigint AS bytes`,
		)) as Array<{ bytes: number | string }> | { rows: Array<{ bytes: number | string }> };
		const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
		if (row?.bytes !== undefined) dataBytes = Number(row.bytes);
	} catch (err) {
		logger.debug({ err }, "[vitals] pg_database_size failed");
	}

	try {
		const rows = (await db.execute(
			sql`SELECT COALESCE(SUM((pg_ls_waldir()).size), 0)::bigint AS bytes`,
		)) as Array<{ bytes: number | string }> | { rows: Array<{ bytes: number | string }> };
		const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
		if (row?.bytes !== undefined) walBytes = Number(row.bytes);
	} catch (err) {
		logger.debug({ err }, "[vitals] pg_ls_waldir failed (needs superuser; non-fatal)");
	}

	try {
		const rows = (await db.execute(
			sql`SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()`,
		)) as Array<{ n: number | string }> | { rows: Array<{ n: number | string }> };
		const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
		if (row?.n !== undefined) connectionCount = Number(row.n);
	} catch (err) {
		logger.debug({ err }, "[vitals] pg_stat_activity connection count failed");
	}

	try {
		const rows = (await db.execute(
			sql`SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(query_start))), 0)::int AS age
			    FROM pg_stat_activity
			    WHERE state = 'active' AND datname = current_database() AND pid <> pg_backend_pid()`,
		)) as Array<{ age: number | string }> | { rows: Array<{ age: number | string }> };
		const row = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
		if (row?.age !== undefined) oldestQueryAgeSec = Number(row.age);
	} catch (err) {
		logger.debug({ err }, "[vitals] oldest_query_age failed");
	}

	return {
		data_bytes: dataBytes,
		wal_bytes: walBytes,
		connection_count: connectionCount,
		oldest_query_age_sec: oldestQueryAgeSec,
	};
}

function readProcess() {
	return {
		uptime_sec: Math.round(process.uptime()),
		// `restart_count_today` is computed by the gateway collector
		// from the time series of `uptime_sec` it captures — a sudden
		// drop in uptime_sec means the machine restarted. Including
		// the raw uptime here lets the gateway compute that without
		// the colony having to keep state across restarts.
		paperclip_version: serverVersion,
		node_version: process.version,
	};
}

function readFlyMetadata() {
	// Fly injects these env vars on every machine, so we can echo them
	// back to the collector without an API round-trip.
	return {
		fly_app: process.env.FLY_APP_NAME ?? null,
		fly_machine_id: process.env.FLY_MACHINE_ID ?? null,
		fly_region: process.env.FLY_REGION ?? null,
		fly_image_ref: process.env.FLY_IMAGE_REF ?? null,
	};
}

export function vitalsRoutes(db?: Db) {
	const router = Router();

	router.get("/vitals", async (req, res) => {
		const expected = process.env.HIVE_BOOTSTRAP_SECRET;
		if (!expected) {
			// Without HIVE_BOOTSTRAP_SECRET the colony has no way to
			// authenticate the gateway, so refuse to serve vitals.
			res.status(503).json({ error: "vitals_not_configured" });
			return;
		}
		const provided = bearerTokenFromHeader(req.get("authorization"));
		if (!provided || !constantTimeEqual(provided, expected)) {
			res.status(401).json({ error: "unauthorized" });
			return;
		}

		const mountPath = process.env.PAPERCLIP_DATA_DIR?.trim() || "/paperclip";
		const disk = readDisk(mountPath);
		const memory = readMemory();
		const cpu = readCpu();
		const processInfo = readProcess();
		const fly = readFlyMetadata();
		const postgres = db
			? await readPostgres(db)
			: { data_bytes: null, wal_bytes: null, connection_count: null, oldest_query_age_sec: null };

		res.json({
			...fly,
			disk,
			memory,
			cpu,
			postgres,
			process: processInfo,
			captured_at: new Date().toISOString(),
		});
	});

	return router;
}
