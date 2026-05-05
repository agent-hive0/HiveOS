import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  accessService,
  companyService,
  logActivity,
} from "../services/index.js";

const bootstrapSchema = z.object({
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminName: z.string().min(1).optional(),
  companyName: z.string().min(1),
  hiveSecret: z.string().min(1),
});

type AuthLike = {
  api: {
    signUpEmail: (input: {
      body: { name: string; email: string; password: string };
      asResponse?: boolean;
    }) => Promise<unknown>;
    signInEmail: (input: {
      body: { email: string; password: string };
      asResponse?: boolean;
    }) => Promise<unknown>;
  };
};

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function extractSessionToken(setCookieRaw: string | string[] | null): string | null {
  if (!setCookieRaw) return null;
  const headers = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw];
  for (const header of headers) {
    // Match any cookie ending in `.session_token` to handle the optional
    // `__Secure-` prefix added when secure cookies are enabled.
    const match = header.match(/(?:^|;\s*)([^=;]*\.session_token)=([^;]+)/);
    if (match?.[2]) {
      try {
        return decodeURIComponent(match[2]);
      } catch {
        return match[2];
      }
    }
  }
  return null;
}

function getSetCookieHeader(response: Response): string | string[] | null {
  // Native fetch Response: `Headers.getSetCookie()` returns the array of
  // raw Set-Cookie headers in modern Node. Fall back to the joined value.
  const headers = response.headers as unknown as {
    getSetCookie?: () => string[];
    get: (name: string) => string | null;
  };
  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) return cookies;
  }
  return headers.get("set-cookie");
}

/**
 * Hive control-plane endpoint. Bootstraps a fresh Paperclip instance:
 *   1. Creates the CEO user (or signs in if already exists).
 *   2. Promotes them to instance admin.
 *   3. Creates the customer's company and grants ownership.
 *   4. Returns the session token, userId, and companyId so the Hive
 *      Gateway can talk to this colony.
 *
 * Idempotent: calling again with the same email returns the existing
 * companyId + a fresh session token.
 */
export function hiveBootstrapRoutes(db: Db, opts: { auth: AuthLike }): Router {
  const router = Router();
  const access = accessService(db);
  const companies = companyService(db);

  router.post("/access/hive-bootstrap", async (req, res) => {
    const expectedSecret = process.env.HIVE_BOOTSTRAP_SECRET;
    if (!expectedSecret) {
      logger.error("HIVE_BOOTSTRAP_SECRET is not configured on this Paperclip instance");
      res.status(500).json({ error: "bootstrap_not_configured" });
      return;
    }

    const parsed = bootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const { adminEmail, adminPassword, adminName, companyName, hiveSecret } =
      parsed.data;

    if (!timingSafeStringEqual(hiveSecret, expectedSecret)) {
      res.status(403).json({ error: "invalid_hive_secret" });
      return;
    }

    const requestId = randomUUID();
    logger.info({ requestId, adminEmail, companyName }, "[hive-bootstrap] starting");

    try {
      const lowerEmail = adminEmail.toLowerCase();
      const existingUser = await db
        .select()
        .from(authUsers)
        .where(eq(authUsers.email, lowerEmail))
        .then((rows) => rows[0] ?? null);

      let userId: string;
      let sessionToken: string;
      let createdUser = false;

      if (existingUser) {
        const signInResponse = (await opts.auth.api.signInEmail({
          body: { email: adminEmail, password: adminPassword },
          asResponse: true,
        })) as Response;
        if (!signInResponse.ok) {
          const text = await signInResponse.text();
          logger.error(
            { requestId, status: signInResponse.status, body: text },
            "[hive-bootstrap] sign-in failed",
          );
          res.status(401).json({
            error: "sign_in_failed",
            message: "Existing user could not be authenticated with provided password",
          });
          return;
        }
        const token = extractSessionToken(getSetCookieHeader(signInResponse));
        if (!token) {
          throw new Error("No session cookie in sign-in response");
        }
        sessionToken = token;
        userId = existingUser.id;
      } else {
        const signUpResponse = (await opts.auth.api.signUpEmail({
          body: {
            name: adminName ?? "CEO",
            email: adminEmail,
            password: adminPassword,
          },
          asResponse: true,
        })) as Response;
        if (!signUpResponse.ok) {
          const text = await signUpResponse.text();
          logger.error(
            { requestId, status: signUpResponse.status, body: text },
            "[hive-bootstrap] sign-up failed",
          );
          res.status(500).json({
            error: "sign_up_failed",
            message: text || `Sign-up returned ${signUpResponse.status}`,
          });
          return;
        }
        const token = extractSessionToken(getSetCookieHeader(signUpResponse));
        if (!token) {
          throw new Error("No session cookie in sign-up response");
        }
        sessionToken = token;
        const newUser = await db
          .select()
          .from(authUsers)
          .where(eq(authUsers.email, lowerEmail))
          .then((rows) => rows[0] ?? null);
        if (!newUser) {
          throw new Error("User row not found after sign-up");
        }
        userId = newUser.id;
        createdUser = true;
      }

      await access.promoteInstanceAdmin(userId);

      const existingMembership = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.membershipRole, "owner"),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      let companyId: string;
      let createdCompany = false;
      if (existingMembership) {
        companyId = existingMembership.companyId;
      } else {
        const company = await companies.create({
          name: companyName,
          description: null,
          budgetMonthlyCents: 0,
        });
        companyId = company.id;
        await access.ensureMembership(
          companyId,
          "user",
          userId,
          "owner",
          "active",
        );
        try {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "company.created",
            entityType: "company",
            entityId: companyId,
            details: { name: company.name, source: "hive-bootstrap" },
          });
        } catch (err) {
          logger.warn(
            { requestId, err },
            "[hive-bootstrap] failed to log company.created activity (non-fatal)",
          );
        }
        createdCompany = true;
      }

      logger.info(
        { requestId, userId, companyId, createdUser, createdCompany },
        "[hive-bootstrap] complete",
      );

      res.json({
        sessionToken,
        userId,
        companyId,
        createdUser,
        createdCompany,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error({ requestId, err }, "[hive-bootstrap] failed");
      res.status(500).json({ error: "bootstrap_failed", message });
    }
  });

  return router;
}
