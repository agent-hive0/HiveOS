/**
 * Sprint A.5 · PR2 — Colony restore service.
 *
 * Counterpart to `colony-backup.ts`. Given a Tigris object key and the
 * same `BACKUP_ENCRYPTION_KEY` used to encrypt the envelope, we:
 *
 *   1. download the encrypted blob from Tigris
 *      (`colonies/{slug}/{YYYY-MM-DD}/{slug}-{ISO}.sql.gz.enc`),
 *   2. AES-256-GCM decrypt the envelope
 *      (`[1B version][12B IV][16B authTag][ciphertext]`),
 *   3. write the decrypted `.sql.gz` to a scratch path under
 *      `HIVE_BACKUP_DIR`,
 *   4. call `runDatabaseRestore()` from `@paperclipai/db` to stream it
 *      into Postgres via `psql`.
 *
 * The binary at `server/src/bin/colony-restore.ts` wraps this for
 * operator use: `pnpm tsx server/src/bin/colony-restore.ts <key>`.
 *
 * This module is dependency-injected end to end so unit tests never
 * touch real Tigris, real Postgres, or the real `psql` binary.
 */

import {
	createDecipheriv,
	createHash,
} from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../middleware/logger.js";
import {
	BACKUP_AES_ALGORITHM,
	BACKUP_AUTH_TAG_BYTES,
	BACKUP_ENVELOPE_VERSION,
	BACKUP_IV_BYTES,
	BACKUP_KEY_BYTES,
	decodeEncryptionKey,
} from "./colony-backup.js";

export type ColonyRestoreConfig = {
	colonySlug: string;
	encryptionKey: Buffer;
	tigris: {
		bucket: string;
		region: string;
		endpoint: string;
		accessKeyId: string;
		secretAccessKey: string;
	};
	backupDir: string;
	connectionString: string;
	connectTimeoutSeconds?: number;
};

export type ColonyRestoreResult = {
	objectKey: string;
	downloadedBytes: number;
	decryptedBytes: number;
	sha256Encrypted: string;
	restoredAt: string;
	durationMs: number;
	scratchPath: string;
};

export interface ColonyRestoreDeps {
	now?: () => Date;
	downloadObject?: (input: {
		bucket: string;
		key: string;
		region: string;
		endpoint: string;
		accessKeyId: string;
		secretAccessKey: string;
	}) => Promise<Buffer>;
	runDatabaseRestore?: (opts: {
		connectionString: string;
		backupFile: string;
		connectTimeoutSeconds?: number;
	}) => Promise<void>;
	unlinkImpl?: (path: string) => Promise<void>;
	mkdirImpl?: (path: string, opts: { recursive: true }) => Promise<unknown>;
	writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
	keepScratchFile?: boolean;
}

/**
 * Decrypts an AES-256-GCM envelope produced by `encryptBackupFile`.
 * Throws on:
 *  - wrong envelope version
 *  - truncated envelope (< version+IV+authTag bytes)
 *  - bad key (cipher auth tag mismatch)
 *  - wrong key length (must be 32 bytes)
 *
 * Returns the original gzipped SQL dump bytes.
 */
export function decryptBackupEnvelope(
	envelope: Buffer,
	encryptionKey: Buffer,
): Buffer {
	if (encryptionKey.length !== BACKUP_KEY_BYTES) {
		throw new Error(
			`decryptBackupEnvelope: key must be ${BACKUP_KEY_BYTES} bytes, got ${encryptionKey.length}`,
		);
	}
	const header = 1 + BACKUP_IV_BYTES + BACKUP_AUTH_TAG_BYTES;
	if (envelope.length < header) {
		throw new Error(
			`decryptBackupEnvelope: envelope too small (${envelope.length} bytes, need >=${header})`,
		);
	}
	const version = envelope.readUInt8(0);
	if (version !== BACKUP_ENVELOPE_VERSION) {
		throw new Error(
			`decryptBackupEnvelope: unsupported envelope version ${version}, expected ${BACKUP_ENVELOPE_VERSION}`,
		);
	}
	const iv = envelope.subarray(1, 1 + BACKUP_IV_BYTES);
	const authTag = envelope.subarray(
		1 + BACKUP_IV_BYTES,
		1 + BACKUP_IV_BYTES + BACKUP_AUTH_TAG_BYTES,
	);
	const ciphertext = envelope.subarray(1 + BACKUP_IV_BYTES + BACKUP_AUTH_TAG_BYTES);
	const decipher = createDecipheriv(BACKUP_AES_ALGORITHM, encryptionKey, iv);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Returns a `ColonyRestoreConfig` if every required env var is set,
 * `null` otherwise. Same env-var contract as `colony-backup` plus the
 * implicit `BACKUP_OBJECT_KEY` for the CLI entrypoint.
 */
export function loadColonyRestoreConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): { config: ColonyRestoreConfig | null; missing: string[] } {
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
		env.HIVE_RESTORE_DATABASE_URL?.trim() ||
		env.HIVE_BACKUP_DATABASE_URL?.trim() ||
		env.DATABASE_URL?.trim() ||
		"postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
	const backupDir = env.HIVE_BACKUP_DIR?.trim() || "/paperclip/backups";
	const connectTimeoutSeconds =
		Number(env.HIVE_RESTORE_CONNECT_TIMEOUT_SECONDS ?? "") || undefined;

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
			backupDir,
			connectionString,
			connectTimeoutSeconds,
		},
		missing: [],
	};
}

/**
 * Single shot: download → decrypt → write → `runDatabaseRestore`.
 *
 * Throws if any step fails. Cleans up the scratch file on success
 * unless `deps.keepScratchFile === true` (handy for the weekly CI
 * restore drill which inspects the file separately).
 */
export async function runColonyRestoreOnce(
	objectKey: string,
	config: ColonyRestoreConfig,
	deps: ColonyRestoreDeps = {},
): Promise<ColonyRestoreResult> {
	const now = (deps.now ?? (() => new Date()))();
	const start = now.getTime();

	let downloadObject = deps.downloadObject;
	if (!downloadObject) {
		const { downloadFromTigris } = await import("./colony-backup-tigris-client.js");
		downloadObject = downloadFromTigris;
	}

	let runDatabaseRestoreFn = deps.runDatabaseRestore;
	if (!runDatabaseRestoreFn) {
		const mod = await import("@paperclipai/db");
		runDatabaseRestoreFn = mod.runDatabaseRestore;
	}

	const mkdirFn = deps.mkdirImpl ?? mkdir;
	const writeFileFn = deps.writeFileImpl ?? writeFile;
	const unlinkFn = deps.unlinkImpl ?? unlink;

	logger.info(
		{ colonySlug: config.colonySlug, objectKey, bucket: config.tigris.bucket },
		"colony-restore: downloading envelope from Tigris",
	);

	const envelope = await downloadObject({
		bucket: config.tigris.bucket,
		key: objectKey,
		region: config.tigris.region,
		endpoint: config.tigris.endpoint,
		accessKeyId: config.tigris.accessKeyId,
		secretAccessKey: config.tigris.secretAccessKey,
	});
	const sha256Encrypted = createHash("sha256").update(envelope).digest("hex");

	logger.info(
		{
			colonySlug: config.colonySlug,
			objectKey,
			downloadedBytes: envelope.length,
			sha256Encrypted,
		},
		"colony-restore: decrypting envelope",
	);

	const plaintext = decryptBackupEnvelope(envelope, config.encryptionKey);

	await mkdirFn(config.backupDir, { recursive: true });
	const scratchPath = scratchRestorePath(config, objectKey, now);
	await writeFileFn(scratchPath, plaintext);

	logger.info(
		{
			colonySlug: config.colonySlug,
			objectKey,
			scratchPath,
			plaintextBytes: plaintext.length,
		},
		"colony-restore: streaming dump into postgres",
	);

	try {
		await runDatabaseRestoreFn({
			connectionString: config.connectionString,
			backupFile: scratchPath,
			connectTimeoutSeconds: config.connectTimeoutSeconds,
		});
	} finally {
		if (!deps.keepScratchFile) {
			try {
				await unlinkFn(scratchPath);
			} catch {
				// best-effort
			}
		}
	}

	const result: ColonyRestoreResult = {
		objectKey,
		downloadedBytes: envelope.length,
		decryptedBytes: plaintext.length,
		sha256Encrypted,
		restoredAt: now.toISOString(),
		durationMs: Date.now() - start,
		scratchPath,
	};

	logger.info(
		{
			colonySlug: config.colonySlug,
			objectKey,
			durationMs: result.durationMs,
			decryptedBytes: result.decryptedBytes,
		},
		"colony-restore: restore complete",
	);

	return result;
}

/**
 * Picks a scratch filename that's safe on disk (no slashes) and
 * preserves enough of the object key to be greppable in a postmortem.
 */
export function scratchRestorePath(
	config: ColonyRestoreConfig,
	objectKey: string,
	now: Date,
): string {
	const tail = objectKey.split("/").pop() || `${config.colonySlug}.sql.gz`;
	const ts = now.toISOString().replace(/[:.]/g, "-");
	// Drop the ".enc" suffix so downstream tools see a true .sql.gz file.
	const decrypted = tail.endsWith(".enc") ? tail.slice(0, -".enc".length) : tail;
	return join(config.backupDir, `restore-${ts}-${decrypted}`);
}
