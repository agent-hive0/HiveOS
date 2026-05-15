#!/usr/bin/env node
/**
 * Sprint A.5 · PR2 — Colony restore CLI.
 *
 * Usage (from inside a colony container, or anywhere with the same
 * env vars + network access to Tigris + the target Postgres):
 *
 *     pnpm tsx server/src/bin/colony-restore.ts <object-key>
 *
 * Required env vars:
 *   - HIVE_COLONY_SLUG (or FLY_APP_NAME fallback)
 *   - BACKUP_ENCRYPTION_KEY      (32 bytes, base64-44 or hex-64)
 *   - TIGRIS_BUCKET
 *   - TIGRIS_ACCESS_KEY_ID
 *   - TIGRIS_SECRET_ACCESS_KEY
 *   - DATABASE_URL               (target Postgres; can be overridden
 *                                 by HIVE_RESTORE_DATABASE_URL when
 *                                 restoring into a sibling cluster)
 *
 * Optional:
 *   - TIGRIS_REGION              (defaults "auto")
 *   - TIGRIS_ENDPOINT            (defaults "https://fly.storage.tigris.dev")
 *   - HIVE_BACKUP_DIR            (defaults "/paperclip/backups")
 *   - HIVE_RESTORE_CONNECT_TIMEOUT_SECONDS
 *   - HIVE_RESTORE_KEEP_SCRATCH=1 to keep the decrypted .sql.gz on
 *     disk after restore (used by the weekly CI drill in A.5 PR6).
 *
 * The CLI exits with non-zero on any failure; pipe the stderr at the
 * `psql` boundary into your incident tooling.
 */

import { logger } from "../middleware/logger.js";
import {
	loadColonyRestoreConfigFromEnv,
	runColonyRestoreOnce,
} from "../services/colony-restore.js";

async function main(): Promise<void> {
	const objectKey = process.argv[2];
	if (!objectKey) {
		console.error("colony-restore: missing required <object-key> argument");
		console.error(
			"  example: colony-restore colonies/hive-acme/2026-05-15/hive-acme-2026-05-15T03-00-00-000Z.sql.gz.enc",
		);
		process.exit(2);
	}

	const { config, missing } = loadColonyRestoreConfigFromEnv();
	if (!config) {
		console.error(
			`colony-restore: refusing to start — missing env vars: ${missing.join(", ")}`,
		);
		process.exit(2);
	}

	const keepScratchFile = process.env.HIVE_RESTORE_KEEP_SCRATCH === "1";

	try {
		const result = await runColonyRestoreOnce(objectKey, config, {
			keepScratchFile,
		});
		logger.info(
			{
				colonySlug: config.colonySlug,
				objectKey: result.objectKey,
				downloadedBytes: result.downloadedBytes,
				decryptedBytes: result.decryptedBytes,
				durationMs: result.durationMs,
				scratchPath: keepScratchFile ? result.scratchPath : undefined,
			},
			"colony-restore: succeeded",
		);
		console.log(
			JSON.stringify({
				ok: true,
				colony_slug: config.colonySlug,
				object_key: result.objectKey,
				downloaded_bytes: result.downloadedBytes,
				decrypted_bytes: result.decryptedBytes,
				sha256_encrypted: result.sha256Encrypted,
				restored_at: result.restoredAt,
				duration_ms: result.durationMs,
				scratch_path: keepScratchFile ? result.scratchPath : null,
			}),
		);
		process.exit(0);
	} catch (err) {
		logger.error({ err, objectKey }, "colony-restore: failed");
		console.error(
			`colony-restore: FAILED — ${err instanceof Error ? err.message : String(err)}`,
		);
		process.exit(1);
	}
}

void main();
