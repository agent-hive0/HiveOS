#!/usr/bin/env node
/**
 * Sprint A.5 · PR6 — Weekly CI restore drill.
 *
 * Exercises the full PR1+PR2 backup→Tigris→restore loop end to end
 * against ephemeral CI infrastructure (real Postgres, MinIO standing
 * in for Tigris) so an unnoticed regression in the encryption
 * envelope, key handling, S3 client config, or pg_dump/psql streaming
 * cannot reach production unspotted.
 *
 * Lifecycle (run inside the weekly-restore-drill workflow):
 *
 *   1. Seed a known fixture row into the Postgres service container
 *      via `seedDrillFixture()`.
 *   2. Run `runColonyBackupOnce()` against the live `pg_dump` binary
 *      and the live MinIO bucket (no stubs).
 *   3. Drop + recreate the `public` schema so the next step has to
 *      load every fixture row from the encrypted backup, not from
 *      residual state.
 *   4. Run `runColonyRestoreOnce()` with `HIVE_RESTORE_KEEP_SCRATCH=1`
 *      so the decrypted `.sql.gz` lingers for the artifact upload.
 *   5. Re-query the fixture rows via `verifyDrillFixture()`. The
 *      script exits non-zero if the row count or payload digest does
 *      not match the seed.
 *
 * The script is dependency-injected so the unit suite
 * (`drill-restore.test.ts`) can drive the verifier with stubbed
 * deps and confirm the failure modes without touching docker.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../src/middleware/logger.js";
import {
	BACKUP_KEY_BYTES,
	runColonyBackupOnce,
	type ColonyBackupConfig,
} from "../src/services/colony-backup.js";
import {
	runColonyRestoreOnce,
	type ColonyRestoreConfig,
} from "../src/services/colony-restore.js";

export const DRILL_TABLE_NAME = "colony_restore_drill_fixture";
export const DRILL_ROW_COUNT = 250;

export type DrillRow = { id: number; payload: string; sha256: string };

/**
 * Deterministic fixture generator. Keyed by `seed` so a re-run with
 * the same seed must produce byte-identical rows — that's how the
 * verifier knows whether the restore replayed every row.
 */
export function buildDrillRows(seed: string, count = DRILL_ROW_COUNT): DrillRow[] {
	const rows: DrillRow[] = [];
	for (let i = 0; i < count; i += 1) {
		const payload = `drill:${seed}:${i}:${"x".repeat(64)}`;
		const sha256 = createHash("sha256").update(payload).digest("hex");
		rows.push({ id: i + 1, payload, sha256 });
	}
	return rows;
}

export function fingerprintDrillRows(rows: DrillRow[]): string {
	const h = createHash("sha256");
	for (const r of rows) {
		h.update(`${r.id}\u0000${r.sha256}\u0000`);
	}
	return h.digest("hex");
}

export interface DrillSql {
	unsafe: (q: string) => Promise<unknown>;
	end: () => Promise<void>;
	/**
	 * Tagged-template-flavour helper used by `verifyDrillFixture` so
	 * unit tests can stub a no-op client without pulling in the real
	 * `postgres` lib.
	 */
	select: <T = unknown>(q: string) => Promise<T[]>;
}

/**
 * Default SQL transport — shells out to `psql`, which the CI workflow
 * already installs (`postgresql-client-16`). This avoids forcing
 * `@paperclipai/server` to take a runtime dep on the `postgres`
 * driver just for a CI tool.
 *
 * Each call spawns a fresh `psql -c` invocation. That's fine at the
 * scale this script runs (250 INSERTs once a week). For `select` we
 * use `--csv --tuples-only` and parse the result into rows shaped
 * like `DrillRow`.
 */
async function openSql(connectionString: string): Promise<DrillSql> {
	const { spawn } = await import("node:child_process");

	async function runPsql(args: string[]): Promise<string> {
		return await new Promise((resolve, reject) => {
			const child = spawn("psql", [connectionString, ...args], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (c) => {
				stdout += c.toString();
			});
			child.stderr.on("data", (c) => {
				stderr += c.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve(stdout);
				else reject(new Error(`psql exited ${code}: ${stderr.trim() || stdout.trim()}`));
			});
		});
	}

	return {
		unsafe: async (q) => {
			await runPsql(["-v", "ON_ERROR_STOP=1", "-c", q]);
		},
		end: async () => {
			/* no persistent connection to close */
		},
		select: async <T,>(q: string): Promise<T[]> => {
			const out = await runPsql([
				"-v",
				"ON_ERROR_STOP=1",
				"--csv",
				"--tuples-only",
				"-c",
				q,
			]);
			return parseCsvDrillRows(out) as unknown as T[];
		},
	};
}

/**
 * Tiny CSV parser scoped to what `psql --csv --tuples-only` produces
 * for the drill fixture (`id,payload,sha256`). We avoid bringing in a
 * full CSV lib because the fixture format is fixed and tests stub
 * `select` end-to-end anyway.
 */
export function parseCsvDrillRows(csv: string): DrillRow[] {
	const rows: DrillRow[] = [];
	const lines = csv.split("\n");
	for (const line of lines) {
		if (!line) continue;
		const fields = parseCsvLine(line);
		if (fields.length < 3) continue;
		const id = Number.parseInt(fields[0], 10);
		if (!Number.isFinite(id)) continue;
		rows.push({ id, payload: fields[1], sha256: fields[2] });
	}
	return rows;
}

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < line.length) {
		let field = "";
		if (line[i] === '"') {
			i += 1;
			while (i < line.length) {
				if (line[i] === '"' && line[i + 1] === '"') {
					field += '"';
					i += 2;
				} else if (line[i] === '"') {
					i += 1;
					break;
				} else {
					field += line[i];
					i += 1;
				}
			}
		} else {
			while (i < line.length && line[i] !== ",") {
				field += line[i];
				i += 1;
			}
		}
		out.push(field);
		if (line[i] === ",") i += 1;
	}
	return out;
}

export type DrillSqlFactory = (connectionString: string) => DrillSql | Promise<DrillSql>;

export async function seedDrillFixture(
	connectionString: string,
	rows: DrillRow[],
	open: DrillSqlFactory = openSql,
): Promise<void> {
	const sql = await open(connectionString);
	try {
		await sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
		await sql.unsafe(`CREATE SCHEMA public`);
		await sql.unsafe(
			`CREATE TABLE public.${DRILL_TABLE_NAME} (
				id integer primary key,
				payload text not null,
				sha256 text not null
			)`,
		);
		// One INSERT per row is fine at N=250 and keeps the SQL trivially
		// inspectable in CI logs when something goes sideways.
		for (const r of rows) {
			const payloadEscaped = r.payload.replace(/'/g, "''");
			await sql.unsafe(
				`INSERT INTO public.${DRILL_TABLE_NAME} (id, payload, sha256) VALUES (${r.id}, '${payloadEscaped}', '${r.sha256}')`,
			);
		}
	} finally {
		await sql.end();
	}
}

export async function wipeDatabase(
	connectionString: string,
	open: DrillSqlFactory = openSql,
): Promise<void> {
	const sql = await open(connectionString);
	try {
		await sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
		await sql.unsafe(`CREATE SCHEMA public`);
	} finally {
		await sql.end();
	}
}

export type DrillVerificationResult = {
	ok: boolean;
	expectedRowCount: number;
	actualRowCount: number;
	expectedFingerprint: string;
	actualFingerprint: string;
	error?: string;
};

export async function verifyDrillFixture(
	connectionString: string,
	expected: DrillRow[],
	open: DrillSqlFactory = openSql,
): Promise<DrillVerificationResult> {
	const expectedFingerprint = fingerprintDrillRows(expected);
	const sql = await open(connectionString);
	try {
		const actual = await sql.select<DrillRow>(
			`SELECT id, payload, sha256 FROM public.${DRILL_TABLE_NAME} ORDER BY id ASC`,
		);
		const actualFingerprint = fingerprintDrillRows(actual);
		const ok =
			actual.length === expected.length && actualFingerprint === expectedFingerprint;
		const result: DrillVerificationResult = {
			ok,
			expectedRowCount: expected.length,
			actualRowCount: actual.length,
			expectedFingerprint,
			actualFingerprint,
		};
		if (!ok) {
			result.error =
				actual.length !== expected.length
					? `restored row count ${actual.length} != expected ${expected.length}`
					: `restored fingerprint ${actualFingerprint} != expected ${expectedFingerprint}`;
		}
		return result;
	} finally {
		await sql.end();
	}
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v || !v.trim()) {
		throw new Error(`drill-restore: missing required env var ${name}`);
	}
	return v.trim();
}

async function main(): Promise<void> {
	const colonySlug = process.env.HIVE_COLONY_SLUG?.trim() || "drill-colony";
	const connectionString = requireEnv("DATABASE_URL");
	const tigrisBucket = requireEnv("TIGRIS_BUCKET");
	const tigrisRegion = process.env.TIGRIS_REGION?.trim() || "auto";
	const tigrisEndpoint = requireEnv("TIGRIS_ENDPOINT");
	const tigrisAccessKey = requireEnv("TIGRIS_ACCESS_KEY_ID");
	const tigrisSecretKey = requireEnv("TIGRIS_SECRET_ACCESS_KEY");
	const encryptionKeyRaw =
		process.env.BACKUP_ENCRYPTION_KEY?.trim() ||
		randomBytes(BACKUP_KEY_BYTES).toString("base64");
	const backupDir = mkdtempSync(join(tmpdir(), "drill-restore-"));
	const seed = process.env.HIVE_DRILL_SEED?.trim() || new Date().toISOString();

	logger.info(
		{ colonySlug, backupDir, seed, tigrisBucket, tigrisEndpoint },
		"drill-restore: starting",
	);

	const rows = buildDrillRows(seed);
	await seedDrillFixture(connectionString, rows);

	const backupConfig: ColonyBackupConfig = {
		colonySlug,
		retentionDays: 1,
		intervalHours: 24,
		encryptionKey: Buffer.from(encryptionKeyRaw, "base64").subarray(0, BACKUP_KEY_BYTES),
		tigris: {
			bucket: tigrisBucket,
			region: tigrisRegion,
			endpoint: tigrisEndpoint,
			accessKeyId: tigrisAccessKey,
			secretAccessKey: tigrisSecretKey,
		},
		backupDir,
		connectionString,
	};

	const backup = await runColonyBackupOnce(backupConfig);
	logger.info(
		{
			objectKey: backup.objectKey,
			encryptedBytes: backup.encryptedBytes,
			plaintextBytes: backup.plaintextBytes,
		},
		"drill-restore: backup uploaded",
	);

	await wipeDatabase(connectionString);

	const restoreConfig: ColonyRestoreConfig = {
		colonySlug,
		encryptionKey: backupConfig.encryptionKey,
		tigris: backupConfig.tigris,
		backupDir,
		connectionString,
	};

	const restore = await runColonyRestoreOnce(backup.objectKey, restoreConfig, {
		keepScratchFile: process.env.HIVE_RESTORE_KEEP_SCRATCH === "1",
	});
	logger.info(
		{
			objectKey: restore.objectKey,
			decryptedBytes: restore.decryptedBytes,
			durationMs: restore.durationMs,
			scratchPath: restore.scratchPath,
		},
		"drill-restore: restore complete",
	);

	const verify = await verifyDrillFixture(connectionString, rows);
	if (!verify.ok) {
		logger.error({ verify }, "drill-restore: verification FAILED");
		console.error(`drill-restore: FAILED — ${verify.error ?? "unknown verification error"}`);
		console.error(JSON.stringify(verify));
		process.exit(1);
	}

	console.log(
		JSON.stringify({
			ok: true,
			colony_slug: colonySlug,
			object_key: backup.objectKey,
			encrypted_bytes: backup.encryptedBytes,
			decrypted_bytes: restore.decryptedBytes,
			restore_duration_ms: restore.durationMs,
			rows_verified: verify.actualRowCount,
			fingerprint: verify.actualFingerprint,
			scratch_path: existsSync(restore.scratchPath) ? restore.scratchPath : null,
		}),
	);
}

// Only run main when invoked as a script (not when imported by tests).
const invokedDirectly =
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith("drill-restore.ts") ||
	process.argv[1]?.endsWith("drill-restore.js");
if (invokedDirectly) {
	void main().catch((err) => {
		logger.error({ err }, "drill-restore: top-level failure");
		console.error(
			`drill-restore: FAILED — ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	});
}
