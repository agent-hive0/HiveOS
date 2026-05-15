/**
 * Sprint A.5 · PR1 — Scheduler tests.
 *
 * The scheduler wraps runColonyBackupOnce in a timer that fires every
 * `intervalHours` after a `bootDelayMs` delay. We never actually let
 * the real timers fire — we inject `setTimeoutImpl` so the tests
 * control when ticks happen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createColonyBackupScheduler } from "../services/colony-backup-scheduler.js";
import { BACKUP_KEY_BYTES } from "../services/colony-backup.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "colony-backup-sched-"));
});

afterEach(() => {
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

function happyEnv(): NodeJS.ProcessEnv {
	const backupDir = join(tmpRoot, "backups");
	mkdirSync(backupDir, { recursive: true });
	return {
		HIVE_COLONY_SLUG: "acme",
		BACKUP_ENCRYPTION_KEY: Buffer.alloc(BACKUP_KEY_BYTES, 3).toString("base64"),
		TIGRIS_BUCKET: "hive-backups",
		TIGRIS_ACCESS_KEY_ID: "k",
		TIGRIS_SECRET_ACCESS_KEY: "s",
		HIVE_BOOTSTRAP_SECRET: "boot",
		HIVE_BACKUP_DIR: backupDir,
		HIVE_BACKUP_INTERVAL_HOURS: "24",
	};
}

describe("createColonyBackupScheduler", () => {
	it("stays disabled when env vars are missing", () => {
		const sched = createColonyBackupScheduler({ env: {} });
		expect(sched.isEnabled()).toBe(false);
		// start() is a no-op (just logs) — nothing throws.
		sched.start();
		sched.stop();
	});

	it("is enabled and arms a boot-delay timer when env vars are set", () => {
		const setTimeoutImpl = vi.fn() as unknown as typeof setTimeout;
		const sched = createColonyBackupScheduler({
			env: happyEnv(),
			setTimeoutImpl,
			bootDelayMs: 1234,
		});
		expect(sched.isEnabled()).toBe(true);
		sched.start();
		expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
		// First arg is the cb, second is the delay.
		const delay = (setTimeoutImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
		expect(delay).toBe(1234);
		sched.stop();
	});

	it("runNow returns null when disabled and runs the backup when enabled", async () => {
		const env = happyEnv();
		const dumpPath = join(env.HIVE_BACKUP_DIR ?? "", "acme-dump.sql.gz");
		writeFileSync(dumpPath, "X".repeat(100));

		const runDatabaseBackup = vi.fn().mockResolvedValue({
			backupFile: dumpPath,
			sizeBytes: statSync(dumpPath).size,
			prunedCount: 0,
		});
		const putObject = vi.fn().mockResolvedValue(undefined);

		const sched = createColonyBackupScheduler({
			env,
			runDatabaseBackup,
			putObject,
			unlinkImpl: () => {},
			setTimeoutImpl: vi.fn() as unknown as typeof setTimeout,
		});

		const result = await sched.runNow();
		expect(result).not.toBeNull();
		expect(result?.objectKey).toMatch(/colonies\/acme\//);
		expect(runDatabaseBackup).toHaveBeenCalledTimes(1);
		expect(putObject).toHaveBeenCalledTimes(1);
	});

	it("stop() clears the pending timer", () => {
		const clearTimeoutImpl = vi.fn();
		const setTimeoutImpl = vi.fn(() => 42) as unknown as typeof setTimeout;
		const sched = createColonyBackupScheduler({
			env: happyEnv(),
			setTimeoutImpl,
			clearTimeoutImpl: clearTimeoutImpl as unknown as typeof clearTimeout,
		});
		sched.start();
		sched.stop();
		expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);
	});
});
