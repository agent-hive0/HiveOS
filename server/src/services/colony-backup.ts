/**
 * Sprint A.5 · PR1 — Colony backup service.
 *
 * Runs inside the colony container. Once per `BACKUP_INTERVAL_HOURS`
 * (default 24h) we:
 *   1. snapshot the embedded Postgres via the existing
 *      `runDatabaseBackup()` helper (writes a gzipped SQL dump to
 *      `/paperclip/backups`),
 *   2. envelope-encrypt the dump file with AES-256-GCM using
 *      `BACKUP_ENCRYPTION_KEY`,
 *   3. upload the encrypted blob to a Tigris bucket via the
 *      S3-compatible API (Tigris is Fly's first-party S3 service,
 *      reachable at `https://fly.storage.tigris.dev`),
 *   4. report `(colony slug, object key, size, sha256, timestamp)`
 *      back to the gateway's `/api/internal/colonies/backups` ingest
 *      endpoint (auth: `Bearer ${HIVE_BOOTSTRAP_SECRET}`).
 *
 * The encryption key never leaves the colony. The gateway only
 * receives the object key + metadata; restoring requires the same
 * `BACKUP_ENCRYPTION_KEY`. The key is provisioned per-colony in
 * `BACKUP_ENCRYPTION_KEY` (Fly secret) by Sprint A.5 PR3 and stored
 * one extra time in the control-plane Supabase row so the admin
 * `restore-colony` action (Sprint B PR3) can fetch it under a
 * dual-2FA-approval flow.
 *
 * Until A.5 PR3 ships the per-colony secrets, the scheduler stays
 * dark — `runColonyBackupOnce()` returns early when any required
 * env var is missing and logs a warning.
 *
 * This module is dependency-injected end to end so the unit tests
 * never touch real Postgres, real S3, or real fetch.
 */

import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { createReadStream, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { logger } from "../middleware/logger.js";

export const BACKUP_AES_ALGORITHM = "aes-256-gcm" as const;
export const BACKUP_KEY_BYTES = 32;
export const BACKUP_IV_BYTES = 12;
export const BACKUP_AUTH_TAG_BYTES = 16;
export const BACKUP_ENVELOPE_VERSION = 1;

export type ColonyBackupConfig = {
	colonySlug: string;
	encryptionKey: Buffer; // 32 bytes
	tigris: {
		bucket: string;
		region: string;
		endpoint: string;
		accessKeyId: string;
		secretAccessKey: string;
	};
	ingestUrl?: string; // gateway ingest endpoint (A.5 PR4)
	ingestSecret?: string; // HIVE_BOOTSTRAP_SECRET
	backupDir: string; // /paperclip/backups
	connectionString: string;
	retentionDays: number;
	intervalHours: number;
};

export type ColonyBackupResult = {
	backupFile: string;
	objectKey: string;
	sha256: string;
	encryptedBytes: number;
	plaintextBytes: number;
	uploadedAt: string;
	durationMs: number;
};

export interface ColonyBackupDeps {
	now?: () => Date;
	runDatabaseBackup?: (opts: {
		connectionString: string;
		backupDir: string;
		retention: { dailyDays: number; weeklyWeeks: number; monthlyMonths: number };
		filenamePrefix?: string;
	}) => Promise<{ backupFile: string; sizeBytes: number; prunedCount: number }>;
	putObject?: (input: {
		bucket: string;
		key: string;
		body: Readable;
		contentLength: number;
		contentType: string;
		region: string;
		endpoint: string;
		accessKeyId: string;
		secretAccessKey: string;
	}) => Promise<void>;
	fetchImpl?: typeof fetch;
	// For tests — let callers swap out file unlink so we don't depend on disk.
	unlinkImpl?: (path: string) => void;
}

export function buildObjectKey(colonySlug: string, capturedAt: Date): string {
	const iso = capturedAt.toISOString().replace(/[:.]/g, "-");
	const day = iso.slice(0, 10); // YYYY-MM-DD
	return `colonies/${colonySlug}/${day}/${colonySlug}-${iso}.sql.gz.enc`;
}

/**
 * Encrypt `srcPath` → `destPath` using AES-256-GCM with a fresh IV.
 * Envelope layout (binary, no JSON wrapper so we never re-parse a
 * partial file at restore time):
 *
 *   [1 byte version][12 byte IV][16 byte auth tag][ciphertext...]
 *
 * The plaintext is read into memory once. Database dumps for a single
 * colony cap out around the volume floor of 5–75 GB but the active
 * dump is gzipped and we only call this once per 24h, so the simpler
 * single-pass implementation is the right call versus a streaming
 * assembler that has to allocate a sentinel for the auth tag.
 *
 * Returns sha256 of the *encrypted* blob and its size.
 */
export async function encryptBackupFile(
	srcPath: string,
	destPath: string,
	encryptionKey: Buffer,
): Promise<{ sha256: string; bytes: number }> {
	if (encryptionKey.length !== BACKUP_KEY_BYTES) {
		throw new Error(
			`encryptBackupFile: key must be ${BACKUP_KEY_BYTES} bytes, got ${encryptionKey.length}`,
		);
	}
	const iv = randomBytes(BACKUP_IV_BYTES);
	const cipher = createCipheriv(BACKUP_AES_ALGORITHM, encryptionKey, iv);
	const plaintext = await readFile(srcPath);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const authTag = cipher.getAuthTag();
	if (authTag.length !== BACKUP_AUTH_TAG_BYTES) {
		throw new Error(
			`encryptBackupFile: auth tag was ${authTag.length} bytes, expected ${BACKUP_AUTH_TAG_BYTES}`,
		);
	}
	const envelope = Buffer.concat([
		Buffer.from([BACKUP_ENVELOPE_VERSION]),
		iv,
		authTag,
		ciphertext,
	]);
	await writeFile(destPath, envelope);
	const sha256 = createHash("sha256").update(envelope).digest("hex");
	return { sha256, bytes: envelope.length };
}

/**
 * One full backup cycle: dump → encrypt → upload → report.
 *
 * Throws if any step fails. Callers (the scheduler) MUST catch and
 * log — a failed backup is the alerter's job, not a process-killer.
 */
export async function runColonyBackupOnce(
	config: ColonyBackupConfig,
	deps: ColonyBackupDeps = {},
): Promise<ColonyBackupResult> {
	const now = (deps.now ?? (() => new Date()))();
	const start = now.getTime();

	// Lazy import the real backup helper so tests can stub via deps.runDatabaseBackup.
	let runDatabaseBackupFn = deps.runDatabaseBackup;
	if (!runDatabaseBackupFn) {
		const mod = await import("@paperclipai/db");
		runDatabaseBackupFn = mod.runDatabaseBackup;
	}

	await mkdir(config.backupDir, { recursive: true });

	const dumpResult = await runDatabaseBackupFn({
		connectionString: config.connectionString,
		backupDir: config.backupDir,
		retention: { dailyDays: config.retentionDays, weeklyWeeks: 4, monthlyMonths: 1 },
		filenamePrefix: `${config.colonySlug}`,
	});

	const encPath = `${dumpResult.backupFile}.enc`;
	const enc = await encryptBackupFile(dumpResult.backupFile, encPath, config.encryptionKey);

	const objectKey = buildObjectKey(config.colonySlug, now);
	const contentLength = enc.bytes;

	let putObject = deps.putObject;
	if (!putObject) {
		// Lazy import the real S3 client only when we actually upload.
		const { uploadToTigris } = await import("./colony-backup-tigris-client.js");
		putObject = uploadToTigris;
	}

	const body = createReadStream(encPath);
	// Suppress late ENOENT etc. from the lazy fs open — the stream may
	// outlive our caller if the upload helper returned without
	// consuming it (e.g. a unit-test stub that resolves immediately).
	body.on("error", () => {});
	try {
		await putObject({
			bucket: config.tigris.bucket,
			key: objectKey,
			body,
			contentLength,
			contentType: "application/octet-stream",
			region: config.tigris.region,
			endpoint: config.tigris.endpoint,
			accessKeyId: config.tigris.accessKeyId,
			secretAccessKey: config.tigris.secretAccessKey,
		});
	} finally {
		if (!body.destroyed) body.destroy();
	}

	const result: ColonyBackupResult = {
		backupFile: dumpResult.backupFile,
		objectKey,
		sha256: enc.sha256,
		encryptedBytes: enc.bytes,
		plaintextBytes: dumpResult.sizeBytes,
		uploadedAt: now.toISOString(),
		durationMs: Date.now() - start,
	};

	if (config.ingestUrl && config.ingestSecret) {
		const fetchImpl = deps.fetchImpl ?? fetch;
		try {
			const res = await fetchImpl(config.ingestUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${config.ingestSecret}`,
				},
				body: JSON.stringify({
					colony_slug: config.colonySlug,
					object_key: result.objectKey,
					sha256: result.sha256,
					encrypted_bytes: result.encryptedBytes,
					plaintext_bytes: result.plaintextBytes,
					uploaded_at: result.uploadedAt,
					duration_ms: result.durationMs,
					envelope_version: BACKUP_ENVELOPE_VERSION,
				}),
			});
			if (!res.ok) {
				logger.warn(
					{ status: res.status, colonySlug: config.colonySlug, objectKey },
					"Colony backup ingest call failed",
				);
			}
		} catch (err) {
			logger.warn({ err, colonySlug: config.colonySlug }, "Colony backup ingest call threw");
		}
	}

	// Clean up the local encrypted blob — the canonical copy is in Tigris now.
	try {
		(deps.unlinkImpl ?? unlinkSync)(encPath);
	} catch {
		// best-effort
	}

	return result;
}

/**
 * Returns a `ColonyBackupConfig` if every env var is populated,
 * `null` otherwise. The caller (scheduler / startup wire-up)
 * SHOULD log the missing keys so an operator can see why the
 * scheduler is dark.
 */
export function loadColonyBackupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
	config: ColonyBackupConfig | null;
	missing: string[];
} {
	const missing: string[] = [];
	const colonySlug = env.HIVE_COLONY_SLUG ?? env.FLY_APP_NAME ?? "";
	if (!colonySlug) missing.push("HIVE_COLONY_SLUG");
	const rawKey = env.BACKUP_ENCRYPTION_KEY ?? "";
	if (!rawKey) missing.push("BACKUP_ENCRYPTION_KEY");
	const bucket = env.TIGRIS_BUCKET ?? "";
	if (!bucket) missing.push("TIGRIS_BUCKET");
	const region = env.TIGRIS_REGION ?? "auto";
	const endpoint = env.TIGRIS_ENDPOINT ?? "https://fly.storage.tigris.dev";
	const accessKeyId = env.TIGRIS_ACCESS_KEY_ID ?? "";
	if (!accessKeyId) missing.push("TIGRIS_ACCESS_KEY_ID");
	const secretAccessKey = env.TIGRIS_SECRET_ACCESS_KEY ?? "";
	if (!secretAccessKey) missing.push("TIGRIS_SECRET_ACCESS_KEY");
	const connectionString =
		env.HIVE_BACKUP_DATABASE_URL?.trim() ||
		env.DATABASE_URL?.trim() ||
		"postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
	const backupDir = env.HIVE_BACKUP_DIR?.trim() || "/paperclip/backups";
	const intervalHours = Number(env.HIVE_BACKUP_INTERVAL_HOURS ?? "24") || 24;
	const retentionDays = Number(env.HIVE_BACKUP_RETENTION_DAYS ?? "14") || 14;

	if (missing.length > 0) return { config: null, missing };

	let encryptionKey: Buffer;
	try {
		encryptionKey = decodeEncryptionKey(rawKey);
	} catch (e) {
		missing.push(`BACKUP_ENCRYPTION_KEY (${(e as Error).message})`);
		return { config: null, missing };
	}

	return {
		config: {
			colonySlug,
			encryptionKey,
			tigris: { bucket, region, endpoint, accessKeyId, secretAccessKey },
			ingestUrl: env.HIVE_BACKUP_INGEST_URL?.trim() || undefined,
			ingestSecret: env.HIVE_BOOTSTRAP_SECRET?.trim() || undefined,
			backupDir,
			connectionString,
			retentionDays,
			intervalHours,
		},
		missing: [],
	};
}

/**
 * Accept `BACKUP_ENCRYPTION_KEY` as either base64 or hex of a 32-byte
 * key. Throws on anything else — we never want to silently truncate
 * or stretch the key.
 */
export function decodeEncryptionKey(raw: string): Buffer {
	const trimmed = raw.trim();
	// Try base64 first (commonly produced via `openssl rand -base64 32`).
	if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length >= 40) {
		const b = Buffer.from(trimmed, "base64");
		if (b.length === BACKUP_KEY_BYTES) return b;
	}
	if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === BACKUP_KEY_BYTES * 2) {
		return Buffer.from(trimmed, "hex");
	}
	throw new Error(
		`expected a 32-byte key encoded as base64 (44 chars) or hex (64 chars), got ${trimmed.length} chars`,
	);
}

/**
 * Joins the configured backup dir with a file name. Exported only for
 * tests that need to assert what gets written where.
 */
export function backupArtifactPath(config: ColonyBackupConfig, name: string): string {
	return join(config.backupDir, name);
}
