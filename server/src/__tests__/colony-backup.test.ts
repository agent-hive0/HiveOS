/**
 * Sprint A.5 · PR1 — colony-backup unit tests.
 *
 * Cover the encryption envelope (round-trip + key length), key
 * decoding (base64 / hex / reject), env config loading (happy path
 * + each missing key), and the full `runColonyBackupOnce` orchestrator
 * with the dump/encrypt/upload/ingest pipeline all dependency-injected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
	BACKUP_AUTH_TAG_BYTES,
	BACKUP_ENVELOPE_VERSION,
	BACKUP_IV_BYTES,
	BACKUP_KEY_BYTES,
	buildObjectKey,
	decodeEncryptionKey,
	encryptBackupFile,
	loadColonyBackupConfigFromEnv,
	runColonyBackupOnce,
	type ColonyBackupConfig,
} from "../services/colony-backup.js";
import { createDecipheriv } from "node:crypto";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "colony-backup-test-"));
});

afterEach(() => {
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("decodeEncryptionKey", () => {
	it("accepts a 64-char hex string", () => {
		const hex = "a".repeat(64);
		const buf = decodeEncryptionKey(hex);
		expect(buf.length).toBe(BACKUP_KEY_BYTES);
	});

	it("accepts a 44-char base64 string", () => {
		const buf = Buffer.alloc(BACKUP_KEY_BYTES, 7);
		const b64 = buf.toString("base64");
		expect(b64.length).toBe(44);
		const out = decodeEncryptionKey(b64);
		expect(out.equals(buf)).toBe(true);
	});

	it("rejects an obviously-wrong key", () => {
		expect(() => decodeEncryptionKey("too-short")).toThrow(/32-byte key/);
	});

	it("rejects a base64-shaped string that decodes to the wrong length", () => {
		const wrong = Buffer.alloc(16).toString("base64");
		expect(() => decodeEncryptionKey(wrong)).toThrow(/32-byte key/);
	});
});

describe("encryptBackupFile", () => {
	it("round-trips a plaintext file via AES-256-GCM with the envelope header", async () => {
		const key = Buffer.alloc(BACKUP_KEY_BYTES, 13);
		const plaintext = Buffer.from("hello colony backup ".repeat(50));
		const src = join(tmpRoot, "src.bin");
		const dst = join(tmpRoot, "dst.enc");
		writeFileSync(src, plaintext);

		const out = await encryptBackupFile(src, dst, key);
		expect(out.bytes).toBeGreaterThan(plaintext.length);
		expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);

		const enc = readFileSync(dst);
		expect(enc[0]).toBe(BACKUP_ENVELOPE_VERSION);
		const iv = enc.subarray(1, 1 + BACKUP_IV_BYTES);
		const authTag = enc.subarray(1 + BACKUP_IV_BYTES, 1 + BACKUP_IV_BYTES + BACKUP_AUTH_TAG_BYTES);
		const ciphertext = enc.subarray(1 + BACKUP_IV_BYTES + BACKUP_AUTH_TAG_BYTES);
		expect(iv.length).toBe(BACKUP_IV_BYTES);
		expect(authTag.length).toBe(BACKUP_AUTH_TAG_BYTES);

		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(authTag);
		const recovered = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		expect(recovered.equals(plaintext)).toBe(true);
	});

	it("rejects a key with the wrong length", async () => {
		const src = join(tmpRoot, "src.bin");
		writeFileSync(src, "hi");
		await expect(encryptBackupFile(src, join(tmpRoot, "out.enc"), Buffer.alloc(16))).rejects.toThrow(
			/32 bytes/,
		);
	});
});

describe("buildObjectKey", () => {
	it("partitions by colony slug and UTC day", () => {
		const key = buildObjectKey("acme", new Date("2026-05-15T12:34:56.789Z"));
		expect(key.startsWith("colonies/acme/2026-05-15/")).toBe(true);
		expect(key.endsWith(".sql.gz.enc")).toBe(true);
	});

	it("never produces colons in the filename", () => {
		const key = buildObjectKey("acme", new Date("2026-05-15T12:34:56.789Z"));
		expect(key.includes(":")).toBe(false);
	});
});

describe("loadColonyBackupConfigFromEnv", () => {
	const happyEnv: NodeJS.ProcessEnv = {
		HIVE_COLONY_SLUG: "acme",
		BACKUP_ENCRYPTION_KEY: Buffer.alloc(BACKUP_KEY_BYTES, 9).toString("base64"),
		TIGRIS_BUCKET: "hive-backups",
		TIGRIS_ACCESS_KEY_ID: "tigris_key",
		TIGRIS_SECRET_ACCESS_KEY: "tigris_secret",
		HIVE_BOOTSTRAP_SECRET: "boot",
	};

	it("returns a populated config when every required env var is set", () => {
		const { config, missing } = loadColonyBackupConfigFromEnv(happyEnv);
		expect(missing).toEqual([]);
		expect(config).not.toBeNull();
		expect(config?.colonySlug).toBe("acme");
		expect(config?.tigris.bucket).toBe("hive-backups");
		expect(config?.tigris.region).toBe("auto");
		expect(config?.tigris.endpoint).toBe("https://fly.storage.tigris.dev");
		expect(config?.encryptionKey.length).toBe(BACKUP_KEY_BYTES);
		expect(config?.intervalHours).toBe(24);
		expect(config?.retentionDays).toBe(14);
	});

	it("falls back to FLY_APP_NAME for the colony slug", () => {
		const env = { ...happyEnv };
		delete env.HIVE_COLONY_SLUG;
		env.FLY_APP_NAME = "fly-app";
		const { config } = loadColonyBackupConfigFromEnv(env);
		expect(config?.colonySlug).toBe("fly-app");
	});

	it("reports each missing required key", () => {
		const env: NodeJS.ProcessEnv = {};
		const { config, missing } = loadColonyBackupConfigFromEnv(env);
		expect(config).toBeNull();
		expect(missing).toEqual(
			expect.arrayContaining([
				"HIVE_COLONY_SLUG",
				"BACKUP_ENCRYPTION_KEY",
				"TIGRIS_BUCKET",
				"TIGRIS_ACCESS_KEY_ID",
				"TIGRIS_SECRET_ACCESS_KEY",
			]),
		);
	});

	it("returns null + missing entry when the encryption key is malformed", () => {
		const env = { ...happyEnv, BACKUP_ENCRYPTION_KEY: "not-a-key" };
		const { config, missing } = loadColonyBackupConfigFromEnv(env);
		expect(config).toBeNull();
		expect(missing.some((m) => m.startsWith("BACKUP_ENCRYPTION_KEY"))).toBe(true);
	});
});

describe("runColonyBackupOnce", () => {
	function makeConfig(overrides: Partial<ColonyBackupConfig> = {}): ColonyBackupConfig {
		const backupDir = join(tmpRoot, "backups");
		mkdirSync(backupDir, { recursive: true });
		return {
			colonySlug: "acme",
			encryptionKey: Buffer.alloc(BACKUP_KEY_BYTES, 5),
			tigris: {
				bucket: "hive-backups",
				region: "auto",
				endpoint: "https://fly.storage.tigris.dev",
				accessKeyId: "k",
				secretAccessKey: "s",
			},
			ingestUrl: "https://gw.test/api/internal/colonies/backups",
			ingestSecret: "boot",
			backupDir,
			connectionString: "postgres://x/y",
			retentionDays: 14,
			intervalHours: 24,
			...overrides,
		};
	}

	it("runs dump → encrypt → upload → ingest end-to-end", async () => {
		const config = makeConfig();
		const dumpPath = join(config.backupDir, "acme-dump.sql.gz");
		writeFileSync(dumpPath, "PG DUMP CONTENTS ".repeat(20));

		const runDatabaseBackup = vi.fn().mockResolvedValue({
			backupFile: dumpPath,
			sizeBytes: statSync(dumpPath).size,
			prunedCount: 0,
		});
		const putObject = vi.fn().mockResolvedValue(undefined);
		const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

		const now = new Date("2026-05-15T12:00:00Z");
		const result = await runColonyBackupOnce(config, {
			now: () => now,
			runDatabaseBackup,
			putObject,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(runDatabaseBackup).toHaveBeenCalledTimes(1);
		const dumpCall = runDatabaseBackup.mock.calls[0]?.[0];
		expect(dumpCall.connectionString).toBe(config.connectionString);
		expect(dumpCall.backupDir).toBe(config.backupDir);
		expect(dumpCall.filenamePrefix).toBe("acme");

		expect(putObject).toHaveBeenCalledTimes(1);
		const putCall = putObject.mock.calls[0]?.[0];
		expect(putCall.bucket).toBe("hive-backups");
		expect(putCall.region).toBe("auto");
		expect(putCall.endpoint).toBe("https://fly.storage.tigris.dev");
		expect(putCall.key.startsWith("colonies/acme/2026-05-15/")).toBe(true);
		expect(putCall.contentType).toBe("application/octet-stream");
		expect(putCall.contentLength).toBe(result.encryptedBytes);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const ingestInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
		expect((ingestInit.headers as Record<string, string>).authorization).toBe("Bearer boot");
		const ingestBody = JSON.parse(String(ingestInit.body));
		expect(ingestBody.colony_slug).toBe("acme");
		expect(ingestBody.object_key).toBe(result.objectKey);
		expect(ingestBody.sha256).toBe(result.sha256);
		expect(ingestBody.envelope_version).toBe(BACKUP_ENVELOPE_VERSION);

		expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(result.uploadedAt).toBe(now.toISOString());
	});

	it("skips the ingest call when ingestUrl is unset and still uploads", async () => {
		const config = makeConfig({ ingestUrl: undefined, ingestSecret: undefined });
		const dumpPath = join(config.backupDir, "acme-dump.sql.gz");
		writeFileSync(dumpPath, "X");
		const runDatabaseBackup = vi.fn().mockResolvedValue({
			backupFile: dumpPath,
			sizeBytes: 1,
			prunedCount: 0,
		});
		const putObject = vi.fn().mockResolvedValue(undefined);
		const fetchImpl = vi.fn();

		await runColonyBackupOnce(config, {
			now: () => new Date(),
			runDatabaseBackup,
			putObject,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(putObject).toHaveBeenCalledTimes(1);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("swallows ingest fetch errors so a failed report does not abort the backup", async () => {
		const config = makeConfig();
		const dumpPath = join(config.backupDir, "acme-dump.sql.gz");
		writeFileSync(dumpPath, "X");
		const runDatabaseBackup = vi.fn().mockResolvedValue({
			backupFile: dumpPath,
			sizeBytes: 1,
			prunedCount: 0,
		});
		const putObject = vi.fn().mockResolvedValue(undefined);
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ingest unreachable"));

		const result = await runColonyBackupOnce(config, {
			now: () => new Date(),
			runDatabaseBackup,
			putObject,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(result.objectKey).toMatch(/colonies\/acme\//);
	});

	it("propagates upload errors (the scheduler is the one that swallows)", async () => {
		const config = makeConfig();
		const dumpPath = join(config.backupDir, "acme-dump.sql.gz");
		writeFileSync(dumpPath, "X");
		const runDatabaseBackup = vi.fn().mockResolvedValue({
			backupFile: dumpPath,
			sizeBytes: 1,
			prunedCount: 0,
		});
		const putObject = vi.fn().mockRejectedValue(new Error("tigris 500"));

		await expect(
			runColonyBackupOnce(config, {
				now: () => new Date(),
				runDatabaseBackup,
				putObject,
				unlinkImpl: () => {},
			}),
		).rejects.toThrow(/tigris 500/);
	});
});
