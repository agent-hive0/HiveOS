/**
 * Sprint A.5 · PR1 — In-process backup scheduler.
 *
 * Fires `runColonyBackupOnce` every `intervalHours` (default 24h)
 * inside the colony container. Designed to be cheap, jitter-tolerant,
 * and safe to call repeatedly:
 *   - if `BACKUP_ENCRYPTION_KEY` / Tigris creds aren't set, the
 *     scheduler logs once at startup and stays dark (no crashes,
 *     no churn)
 *   - the very first tick fires 5 min after boot so we don't race
 *     bootstrap, then the next tick fires `intervalHours` later
 *   - if a tick overlaps a previous still-running tick we skip and
 *     log — no concurrent backups against the same Postgres
 *
 * Returns a stop() handle so app.ts can clear the timer in tests.
 */

import { logger } from "../middleware/logger.js";
import {
	loadColonyBackupConfigFromEnv,
	runColonyBackupOnce,
	type ColonyBackupConfig,
	type ColonyBackupDeps,
	type ColonyBackupResult,
} from "./colony-backup.js";

export const BACKUP_BOOT_DELAY_MS = 5 * 60 * 1000; // 5 min

export interface ColonyBackupScheduler {
	start(): void;
	stop(): void;
	runNow(): Promise<ColonyBackupResult | null>;
	isEnabled(): boolean;
}

export interface ColonyBackupSchedulerDeps extends ColonyBackupDeps {
	env?: NodeJS.ProcessEnv;
	setTimeoutImpl?: typeof setTimeout;
	clearTimeoutImpl?: typeof clearTimeout;
	bootDelayMs?: number;
}

export function createColonyBackupScheduler(
	deps: ColonyBackupSchedulerDeps = {},
): ColonyBackupScheduler {
	const env = deps.env ?? process.env;
	const { config, missing } = loadColonyBackupConfigFromEnv(env);
	const setT = deps.setTimeoutImpl ?? setTimeout;
	const clearT = deps.clearTimeoutImpl ?? clearTimeout;
	const bootDelayMs = deps.bootDelayMs ?? BACKUP_BOOT_DELAY_MS;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let stopped = false;

	function scheduleNext(delayMs: number, current: ColonyBackupConfig) {
		if (stopped) return;
		timer = setT(() => {
			void tick(current);
		}, delayMs);
		// Don't keep the event loop alive just for this timer (no-op
		// when an injected setTimeout returns a plain number / handle).
		const handle = timer as unknown as { unref?: () => void } | undefined;
		if (handle && typeof handle.unref === "function") handle.unref();
	}

	async function tick(current: ColonyBackupConfig): Promise<void> {
		if (stopped) return;
		if (running) {
			logger.warn(
				{ colonySlug: current.colonySlug },
				"colony-backup tick skipped — previous run still in progress",
			);
		} else {
			running = true;
			try {
				const result = await runColonyBackupOnce(current, deps);
				logger.info(
					{
						colonySlug: current.colonySlug,
						objectKey: result.objectKey,
						encryptedBytes: result.encryptedBytes,
						durationMs: result.durationMs,
					},
					"colony-backup uploaded",
				);
			} catch (err) {
				logger.error({ err, colonySlug: current.colonySlug }, "colony-backup tick failed");
			} finally {
				running = false;
			}
		}
		scheduleNext(current.intervalHours * 60 * 60 * 1000, current);
	}

	return {
		isEnabled(): boolean {
			return config !== null;
		},
		start(): void {
			if (!config) {
				logger.warn(
					{ missing },
					"colony-backup scheduler disabled — missing env vars; backups will not run",
				);
				return;
			}
			if (timer) return; // already started
			logger.info(
				{
					colonySlug: config.colonySlug,
					intervalHours: config.intervalHours,
					bootDelayMs,
					bucket: config.tigris.bucket,
				},
				"colony-backup scheduler armed",
			);
			scheduleNext(bootDelayMs, config);
		},
		stop(): void {
			stopped = true;
			if (timer) {
				clearT(timer);
				timer = null;
			}
		},
		async runNow(): Promise<ColonyBackupResult | null> {
			if (!config) return null;
			if (running) return null;
			running = true;
			try {
				return await runColonyBackupOnce(config, deps);
			} finally {
				running = false;
			}
		},
	};
}
