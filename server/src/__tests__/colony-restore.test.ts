/**
 * Sprint A.5 · PR2 — Unit tests for colony-restore.
 *
 * Exercises the AES-256-GCM envelope decoder (round-trip with the
 * PR1 encoder), the env-var loader, the scratch-path picker, and the
 * end-to-end orchestrator with every external dep (Tigris, Postgres,
 * fs) stubbed.
 */

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
	BACKUP_AUTH_TAG_BYTES,
	BACKUP_ENVELOPE_VERSION,
	BACKUP_IV_BYTES,
	BACKUP_KEY_BYTES,
	encryptBackupFile,
	decodeEncryptionKey,
} from "../services/colony-backup.js";
import {
	decryptBackupEnvelope,
	loadColonyRestoreConfigFromEnv,
	runColonyRestoreOnce,
	scratchRestorePath,
	type ColonyRestoreConfig,
} from "../services/colony-restore.js";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeKey(): Buffer {
	return randomBytes(BACKUP_KEY_BYTES);
}

function makeBaseConfig(overrides: Partial<ColonyRestoreConfig> = {}): ColonyRestoreConfig {
	return {
		colonySlug: "hive-acme",
		encryptionKey: makeKey(),
		tigris: {
			bucket: "hive-acme-backups",
			region: "auto",
			endpoint: "https://fly.storage.tigris.dev",
			accessKeyId: "AKIA-TEST",
			secretAccessKey: "secret-test",
		},
		backupDir: mkdtempSync(join(tmpdir(), "colony-restore-")),
		connectionString: "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip",
		...overrides,
	};
}

describe("decryptBackupEnvelope", () => {
	it("round-trips a payload encrypted by encryptBackupFile", async () => {
		const key = makeKey();
		const plaintext = Buffer.from("PGDMP-pretend-this-is-a-gzipped-dump\n".repeat(64));
		const dir = mkdtempSync(join(tmpdir(), "colony-restore-rt-"));
		const src = join(dir, "dump.sql.gz");
		const dest = join(dir, "dump.sql.gz.enc");
		writeFileSync(src, plaintext);

		await encryptBackupFile(src, dest, key);
		const envelope = readFileSync(dest);

		const decrypted = decryptBackupEnvelope(envelope, key);
		expect(decrypted.equals(plaintext)).toBe(true);
	});

	it("throws on wrong key length", () => {
		expect(() => decryptBackupEnvelope(Buffer.alloc(64), Buffer.alloc(16))).toThrow(
			/key must be 32 bytes/,
		);
	});

	it("throws on truncated envelope", () => {
		const key = makeKey();
		const stub = Buffer.from([BACKUP_ENVELOPE_VERSION, 0x00, 0x01, 0x02]);
		expect(() => decryptBackupEnvelope(stub, key)).toThrow(/envelope too small/);
	});

	it("throws on unsupported envelope version", () => {
		const key = makeKey();
		const env = Buffer.alloc(1 + BACKUP_IV_BYTES + BACKUP_AUTH_TAG_BYTES + 8);
		env.writeUInt8(99, 0);
		expect(() => decryptBackupEnvelope(env, key)).toThrow(/unsupported envelope version 99/);
	});

	it("throws on wrong key (auth tag mismatch)", async () => {
		const goodKey = makeKey();
		const wrongKey = makeKey();
		const plaintext = Buffer.from("payload-payload-payload");
		const dir = mkdtempSync(join(tmpdir(), "colony-restore-wk-"));
		const src = join(dir, "dump.sql.gz");
		const dest = join(dir, "dump.sql.gz.enc");
		writeFileSync(src, plaintext);
		await encryptBackupFile(src, dest, goodKey);
		const envelope = readFileSync(dest);

		expect(() => decryptBackupEnvelope(envelope, wrongKey)).toThrow();
	});
});

describe("loadColonyRestoreConfigFromEnv", () => {
	const fullEnv = (): NodeJS.ProcessEnv => ({
		HIVE_COLONY_SLUG: "hive-acme",
		BACKUP_ENCRYPTION_KEY: makeKey().toString("hex"),
		TIGRIS_BUCKET: "hive-acme-backups",
		TIGRIS_ACCESS_KEY_ID: "AKIA-TEST",
		TIGRIS_SECRET_ACCESS_KEY: "secret-test",
		DATABASE_URL: "postgres://x:y@host:5432/db",
	});

	it("returns a config when all required vars are set", () => {
		const { config, missing } = loadColonyRestoreConfigFromEnv(fullEnv());
		expect(missing).toEqual([]);
		expect(config).not.toBeNull();
		expect(config?.colonySlug).toBe("hive-acme");
		expect(config?.tigris.region).toBe("auto");
		expect(config?.tigris.endpoint).toBe("https://fly.storage.tigris.dev");
		expect(config?.connectionString).toBe("postgres://x:y@host:5432/db");
	});

	it("reports each missing required var", () => {
		const e = fullEnv();
		delete e.BACKUP_ENCRYPTION_KEY;
		delete e.TIGRIS_BUCKET;
		const { config, missing } = loadColonyRestoreConfigFromEnv(e);
		expect(config).toBeNull();
		expect(missing).toContain("BACKUP_ENCRYPTION_KEY");
		expect(missing).toContain("TIGRIS_BUCKET");
	});

	it("falls back to FLY_APP_NAME when HIVE_COLONY_SLUG is unset", () => {
		const e = fullEnv();
		delete e.HIVE_COLONY_SLUG;
		e.FLY_APP_NAME = "hive-fallback";
		const { config } = loadColonyRestoreConfigFromEnv(e);
		expect(config?.colonySlug).toBe("hive-fallback");
	});

	it("rejects a malformed encryption key", () => {
		const e = fullEnv();
		e.BACKUP_ENCRYPTION_KEY = "too-short";
		const { config, missing } = loadColonyRestoreConfigFromEnv(e);
		expect(config).toBeNull();
		expect(missing.find((m) => m.startsWith("BACKUP_ENCRYPTION_KEY"))).toBeTruthy();
	});

	it("decodes a base64 key end to end", () => {
		const key = makeKey();
		const e = fullEnv();
		e.BACKUP_ENCRYPTION_KEY = key.toString("base64");
		const { config } = loadColonyRestoreConfigFromEnv(e);
		expect(config?.encryptionKey.equals(key)).toBe(true);
	});
});

describe("scratchRestorePath", () => {
	it("strips the .enc suffix and prefixes with restore-<timestamp>-", () => {
		const config = makeBaseConfig();
		const now = new Date("2026-05-15T17:42:00.000Z");
		const objectKey =
			"colonies/hive-acme/2026-05-15/hive-acme-2026-05-15T03-00-00-000Z.sql.gz.enc";
		const out = scratchRestorePath(config, objectKey, now);
		expect(out).toBe(
			join(
				config.backupDir,
				"restore-2026-05-15T17-42-00-000Z-hive-acme-2026-05-15T03-00-00-000Z.sql.gz",
			),
		);
	});

	it("falls back to the colony slug when the key has no tail", () => {
		const config = makeBaseConfig();
		const now = new Date("2026-05-15T17:42:00.000Z");
		const out = scratchRestorePath(config, "", now);
		expect(out.endsWith("hive-acme.sql.gz")).toBe(true);
	});
});

describe("runColonyRestoreOnce", () => {
	it("downloads, decrypts, writes scratch, calls runDatabaseRestore, cleans up", async () => {
		const key = makeKey();
		const config = makeBaseConfig({ encryptionKey: key });
		const objectKey = "colonies/hive-acme/2026-05-15/hive-acme.sql.gz.enc";
		const plaintext = Buffer.from("encoded-dump-bytes");

		// Use the real encoder so we exercise the real decoder.
		const dir = mkdtempSync(join(tmpdir(), "colony-restore-e2e-"));
		const srcPath = join(dir, "dump.sql.gz");
		const encPath = join(dir, "dump.sql.gz.enc");
		writeFileSync(srcPath, plaintext);
		await encryptBackupFile(srcPath, encPath, key);
		const envelope = readFileSync(encPath);

		let downloadCalls = 0;
		let restoreCalls = 0;
		let restoredFromPath: string | null = null;
		let unlinkCalls = 0;

		const result = await runColonyRestoreOnce(objectKey, config, {
			now: () => new Date("2026-05-15T17:42:00.000Z"),
			downloadObject: async (input) => {
				downloadCalls++;
				expect(input.bucket).toBe("hive-acme-backups");
				expect(input.key).toBe(objectKey);
				return envelope;
			},
			runDatabaseRestore: async (opts) => {
				restoreCalls++;
				restoredFromPath = opts.backupFile;
				expect(opts.connectionString).toBe(config.connectionString);
				// Verify the scratch file on disk is the decrypted plaintext.
				const onDisk = readFileSync(opts.backupFile);
				expect(onDisk.equals(plaintext)).toBe(true);
			},
			unlinkImpl: async (path) => {
				unlinkCalls++;
				expect(path).toBe(restoredFromPath);
			},
		});

		expect(downloadCalls).toBe(1);
		expect(restoreCalls).toBe(1);
		expect(unlinkCalls).toBe(1);
		expect(result.objectKey).toBe(objectKey);
		expect(result.decryptedBytes).toBe(plaintext.length);
		expect(result.downloadedBytes).toBe(envelope.length);
		expect(result.sha256Encrypted).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keeps the scratch file when keepScratchFile=true", async () => {
		const key = makeKey();
		const config = makeBaseConfig({ encryptionKey: key });
		const objectKey = "colonies/hive-acme/2026-05-15/hive-acme.sql.gz.enc";
		const plaintext = Buffer.from("encoded-dump-bytes");
		const dir = mkdtempSync(join(tmpdir(), "colony-restore-keep-"));
		const srcPath = join(dir, "dump.sql.gz");
		const encPath = join(dir, "dump.sql.gz.enc");
		writeFileSync(srcPath, plaintext);
		await encryptBackupFile(srcPath, encPath, key);
		const envelope = readFileSync(encPath);

		let unlinkCalls = 0;
		const result = await runColonyRestoreOnce(objectKey, config, {
			downloadObject: async () => envelope,
			runDatabaseRestore: async () => {},
			unlinkImpl: async () => {
				unlinkCalls++;
			},
			keepScratchFile: true,
		});
		expect(unlinkCalls).toBe(0);
		expect(existsSync(result.scratchPath)).toBe(true);
	});

	it("still cleans up scratch when restore throws", async () => {
		const key = makeKey();
		const config = makeBaseConfig({ encryptionKey: key });
		const objectKey = "colonies/hive-acme/2026-05-15/hive-acme.sql.gz.enc";
		const plaintext = Buffer.from("encoded-dump-bytes");
		const dir = mkdtempSync(join(tmpdir(), "colony-restore-err-"));
		const srcPath = join(dir, "dump.sql.gz");
		const encPath = join(dir, "dump.sql.gz.enc");
		writeFileSync(srcPath, plaintext);
		await encryptBackupFile(srcPath, encPath, key);
		const envelope = readFileSync(encPath);

		let unlinkCalls = 0;
		await expect(
			runColonyRestoreOnce(objectKey, config, {
				downloadObject: async () => envelope,
				runDatabaseRestore: async () => {
					throw new Error("psql exploded");
				},
				unlinkImpl: async () => {
					unlinkCalls++;
				},
			}),
		).rejects.toThrow(/psql exploded/);
		expect(unlinkCalls).toBe(1);
	});

	it("propagates download errors", async () => {
		const config = makeBaseConfig();
		await expect(
			runColonyRestoreOnce("colonies/hive-acme/missing.enc", config, {
				downloadObject: async () => {
					throw new Error("Tigris 404");
				},
				runDatabaseRestore: async () => {},
			}),
		).rejects.toThrow(/Tigris 404/);
	});

	it("propagates decrypt errors with the wrong key", async () => {
		const goodKey = makeKey();
		const wrongKey = makeKey();
		const config = makeBaseConfig({ encryptionKey: wrongKey });
		const plaintext = Buffer.from("payload");
		const dir = mkdtempSync(join(tmpdir(), "colony-restore-bad-"));
		const srcPath = join(dir, "dump.sql.gz");
		const encPath = join(dir, "dump.sql.gz.enc");
		writeFileSync(srcPath, plaintext);
		await encryptBackupFile(srcPath, encPath, goodKey);
		const envelope = readFileSync(encPath);

		await expect(
			runColonyRestoreOnce("colonies/hive-acme/x.enc", config, {
				downloadObject: async () => envelope,
				runDatabaseRestore: async () => {},
			}),
		).rejects.toThrow();
	});
});

describe("decodeEncryptionKey shared with restore loader", () => {
	it("accepts the same hex key shape colony-backup produces", () => {
		const k = makeKey();
		const decoded = decodeEncryptionKey(k.toString("hex"));
		expect(decoded.equals(k)).toBe(true);
	});
});
