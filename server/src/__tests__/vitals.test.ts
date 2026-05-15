import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { vitalsRoutes } from "../routes/vitals.js";

function createApp(db?: Db) {
	const app = express();
	app.use("/api/v1/health", vitalsRoutes(db));
	return app;
}

const originalEnv = { ...process.env };

describe("GET /api/v1/health/vitals", () => {
	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.HIVE_BOOTSTRAP_SECRET = "test-bootstrap-secret";
		process.env.FLY_APP_NAME = "hive-test-app";
		process.env.FLY_MACHINE_ID = "machine-abc";
		process.env.FLY_REGION = "iad";
		process.env.FLY_IMAGE_REF = "registry.fly.io/hive-test-app:deployment-01";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = { ...originalEnv };
	});

	it("returns 401 when no Authorization header is present", async () => {
		const app = createApp();
		const res = await request(app).get("/api/v1/health/vitals");
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "unauthorized" });
	});

	it("returns 401 when the bearer token does not match", async () => {
		const app = createApp();
		const res = await request(app)
			.get("/api/v1/health/vitals")
			.set("Authorization", "Bearer wrong-token");
		expect(res.status).toBe(401);
		expect(res.body).toEqual({ error: "unauthorized" });
	});

	it("returns 503 when HIVE_BOOTSTRAP_SECRET is not configured", async () => {
		process.env.HIVE_BOOTSTRAP_SECRET = "";
		const app = createApp();
		const res = await request(app)
			.get("/api/v1/health/vitals")
			.set("Authorization", "Bearer test-bootstrap-secret");
		expect(res.status).toBe(503);
		expect(res.body).toEqual({ error: "vitals_not_configured" });
	});

	it("returns 200 with a full vitals snapshot when the token is correct", async () => {
		const db = {
			execute: vi
				.fn()
				.mockResolvedValueOnce([{ bytes: "123456789" }])
				.mockResolvedValueOnce([{ bytes: "16777216" }])
				.mockResolvedValueOnce([{ n: "7" }])
				.mockResolvedValueOnce([{ age: "12" }]),
		} as unknown as Db;
		const app = createApp(db);

		const res = await request(app)
			.get("/api/v1/health/vitals")
			.set("Authorization", "Bearer test-bootstrap-secret");

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			fly_app: "hive-test-app",
			fly_machine_id: "machine-abc",
			fly_region: "iad",
			fly_image_ref: "registry.fly.io/hive-test-app:deployment-01",
			postgres: {
				data_bytes: 123456789,
				wal_bytes: 16777216,
				connection_count: 7,
				oldest_query_age_sec: 12,
			},
		});
		expect(res.body.memory).toBeTruthy();
		expect(typeof res.body.memory.total_bytes).toBe("number");
		expect(typeof res.body.memory.rss_bytes).toBe("number");
		expect(res.body.cpu).toBeTruthy();
		expect(typeof res.body.cpu.cores).toBe("number");
		expect(res.body.process).toBeTruthy();
		expect(typeof res.body.process.uptime_sec).toBe("number");
		expect(typeof res.body.process.node_version).toBe("string");
		expect(typeof res.body.captured_at).toBe("string");
		expect(db.execute).toHaveBeenCalledTimes(4);
	});

	it("returns 200 with null postgres fields when partial pg probes fail", async () => {
		// First query succeeds, second fails (e.g. pg_ls_waldir needs
		// superuser), third succeeds, fourth fails. The endpoint must
		// keep going and emit partial data instead of 500-ing.
		const db = {
			execute: vi
				.fn()
				.mockResolvedValueOnce([{ bytes: "999" }])
				.mockRejectedValueOnce(new Error("permission denied for function pg_ls_waldir"))
				.mockResolvedValueOnce([{ n: "3" }])
				.mockRejectedValueOnce(new Error("relation pg_stat_activity does not exist")),
		} as unknown as Db;
		const app = createApp(db);

		const res = await request(app)
			.get("/api/v1/health/vitals")
			.set("Authorization", "Bearer test-bootstrap-secret");

		expect(res.status).toBe(200);
		expect(res.body.postgres).toEqual({
			data_bytes: 999,
			wal_bytes: null,
			connection_count: 3,
			oldest_query_age_sec: null,
		});
	});

	it("returns 200 with null postgres block when db is not provided", async () => {
		const app = createApp();
		const res = await request(app)
			.get("/api/v1/health/vitals")
			.set("Authorization", "Bearer test-bootstrap-secret");
		expect(res.status).toBe(200);
		expect(res.body.postgres).toEqual({
			data_bytes: null,
			wal_bytes: null,
			connection_count: null,
			oldest_query_age_sec: null,
		});
	});
});
