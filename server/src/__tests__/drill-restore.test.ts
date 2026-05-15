/**
 * Sprint A.5 · PR6 — Unit tests for the weekly restore drill.
 *
 * Exercises the verification + fixture logic with stubbed Postgres so
 * the suite can run inside the existing CI gate without provisioning
 * a database. The end-to-end loop is exercised by the
 * `weekly-restore-drill` workflow which runs the drill against real
 * Postgres + MinIO service containers.
 */

import { describe, expect, it } from "vitest";
import {
	buildDrillRows,
	DRILL_ROW_COUNT,
	DRILL_TABLE_NAME,
	fingerprintDrillRows,
	parseCsvDrillRows,
	seedDrillFixture,
	verifyDrillFixture,
	wipeDatabase,
	type DrillRow,
	type DrillSql,
} from "../../scripts/drill-restore.js";

function makeStubSql(rows: DrillRow[] = []): {
	sql: DrillSql;
	statements: string[];
	ended: () => boolean;
} {
	const statements: string[] = [];
	let ended = false;
	return {
		sql: {
			unsafe: async (q: string) => {
				statements.push(q);
			},
			end: async () => {
				ended = true;
			},
			select: async <T,>(q: string): Promise<T[]> => {
				statements.push(q);
				return rows as unknown as T[];
			},
		},
		statements,
		ended: () => ended,
	};
}

describe("buildDrillRows", () => {
	it("is deterministic for a given seed", () => {
		const a = buildDrillRows("seed-1");
		const b = buildDrillRows("seed-1");
		expect(a).toEqual(b);
		expect(a.length).toBe(DRILL_ROW_COUNT);
		expect(a[0].id).toBe(1);
		expect(a[a.length - 1].id).toBe(DRILL_ROW_COUNT);
	});

	it("differs across seeds", () => {
		const a = fingerprintDrillRows(buildDrillRows("seed-1"));
		const b = fingerprintDrillRows(buildDrillRows("seed-2"));
		expect(a).not.toBe(b);
	});

	it("respects the count override", () => {
		const rows = buildDrillRows("seed", 5);
		expect(rows.length).toBe(5);
	});
});

describe("fingerprintDrillRows", () => {
	it("is order-sensitive", () => {
		const rows = buildDrillRows("seed", 3);
		const reversed = [...rows].reverse();
		expect(fingerprintDrillRows(rows)).not.toBe(fingerprintDrillRows(reversed));
	});
});

describe("seedDrillFixture", () => {
	it("drops + recreates the public schema and inserts every row", async () => {
		const rows = buildDrillRows("seed-seed", 3);
		const stub = makeStubSql();
		await seedDrillFixture("postgres://stub", rows, () => stub.sql);

		expect(stub.statements[0]).toMatch(/DROP SCHEMA IF EXISTS public/);
		expect(stub.statements[1]).toMatch(/CREATE SCHEMA public/);
		expect(stub.statements[2]).toMatch(
			new RegExp(`CREATE TABLE public.${DRILL_TABLE_NAME}`),
		);
		const insertStatements = stub.statements.filter((s) => s.startsWith("INSERT"));
		expect(insertStatements.length).toBe(3);
		expect(insertStatements[0]).toContain(`(1, '${rows[0].payload}'`);
		expect(stub.ended()).toBe(true);
	});

	it("escapes single quotes in payloads", async () => {
		const rows: DrillRow[] = [{ id: 1, payload: "it's a trap", sha256: "abc" }];
		const stub = makeStubSql();
		await seedDrillFixture("postgres://stub", rows, () => stub.sql);
		const insert = stub.statements.find((s) => s.startsWith("INSERT"));
		expect(insert).toBeDefined();
		expect(insert).toContain("it''s a trap");
	});

	it("calls end() even if a statement throws", async () => {
		let ended = false;
		const failingSql: DrillSql = {
			unsafe: async () => {
				throw new Error("boom");
			},
			end: async () => {
				ended = true;
			},
			select: async () => [],
		};
		await expect(
			seedDrillFixture("postgres://stub", buildDrillRows("s", 1), () => failingSql),
		).rejects.toThrow(/boom/);
		expect(ended).toBe(true);
	});
});

describe("wipeDatabase", () => {
	it("issues exactly DROP SCHEMA + CREATE SCHEMA", async () => {
		const stub = makeStubSql();
		await wipeDatabase("postgres://stub", () => stub.sql);
		expect(stub.statements).toEqual([
			"DROP SCHEMA IF EXISTS public CASCADE",
			"CREATE SCHEMA public",
		]);
		expect(stub.ended()).toBe(true);
	});
});

describe("parseCsvDrillRows", () => {
	it("parses bare tuples", () => {
		const rows = parseCsvDrillRows("1,hello,abc\n2,world,def\n");
		expect(rows).toEqual([
			{ id: 1, payload: "hello", sha256: "abc" },
			{ id: 2, payload: "world", sha256: "def" },
		]);
	});

	it("handles quoted payloads with commas and doubled quotes", () => {
		const rows = parseCsvDrillRows('1,"hello, world",abc\n2,"it ""works""",def\n');
		expect(rows[0].payload).toBe("hello, world");
		expect(rows[1].payload).toBe('it "works"');
	});

	it("skips blank lines and non-numeric ids", () => {
		const rows = parseCsvDrillRows("\n1,a,b\nnotanid,c,d\n");
		expect(rows).toEqual([{ id: 1, payload: "a", sha256: "b" }]);
	});
});

describe("verifyDrillFixture", () => {
	it("reports ok when rows + fingerprint match", async () => {
		const rows = buildDrillRows("seed", 4);
		const stub = makeStubSql(rows);
		const result = await verifyDrillFixture("postgres://stub", rows, () => stub.sql);
		expect(result.ok).toBe(true);
		expect(result.actualRowCount).toBe(4);
		expect(result.expectedFingerprint).toBe(result.actualFingerprint);
		expect(result.error).toBeUndefined();
		expect(stub.ended()).toBe(true);
	});

	it("reports row-count mismatch", async () => {
		const expected = buildDrillRows("seed", 4);
		const stub = makeStubSql(expected.slice(0, 3));
		const result = await verifyDrillFixture("postgres://stub", expected, () => stub.sql);
		expect(result.ok).toBe(false);
		expect(result.actualRowCount).toBe(3);
		expect(result.expectedRowCount).toBe(4);
		expect(result.error).toMatch(/row count 3/);
	});

	it("reports fingerprint mismatch on swapped payload", async () => {
		const expected = buildDrillRows("seed", 4);
		const tampered: DrillRow[] = expected.map((r, i) =>
			i === 1 ? { ...r, sha256: `${r.sha256.slice(0, -1)}f` } : r,
		);
		const stub = makeStubSql(tampered);
		const result = await verifyDrillFixture("postgres://stub", expected, () => stub.sql);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/fingerprint/);
	});

	it("still calls end() when the select throws", async () => {
		let ended = false;
		const failingSql: DrillSql = {
			unsafe: async () => undefined,
			end: async () => {
				ended = true;
			},
			select: async () => {
				throw new Error("connection reset");
			},
		};
		await expect(
			verifyDrillFixture("postgres://stub", buildDrillRows("s", 1), () => failingSql),
		).rejects.toThrow(/connection reset/);
		expect(ended).toBe(true);
	});
});
