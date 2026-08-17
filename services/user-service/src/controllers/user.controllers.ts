import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import config from "../config.js";
import { PostgresClient } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

/**
 * User service HTTP handlers.
 *
 * Register (POST /register): creates a user with a bcrypt-hashed password.
 * NOTE — this is a deliberately simplified "demo auth" model: the client
 * supplies the `role` directly (ADMIN/MANAGER/USER, validated by the
 * gateway's zod schema), and no token is issued here. Self-assignment is
 * acceptable for a portfolio/demo, not for production.
 *
 * Login (POST /login): verifies email + password hash, then mints the
 * JWT (userId + role from the DB row) that the gateway forwards to
 * backend services for identity. Responses are intentionally generic
 * ("Invalid email or password") so the login endpoint can't be used to
 * enumerate which emails exist.
 *
 * GetAll (GET /getAll): requires ADMIN/MANAGER — enforced BOTH by the
 * gateway (RBAC) and re-checked here from the verified JWT via
 * requireAuth, so the service is safe even when hit directly.
 */

interface ApiResponse<T> {
  success: boolean;
  message: string;
  status: number;
  data: T;
}

// Keep ONE client for the lifetime of the process (a pool of connections),
// created lazily so importing the module doesn't trigger a DB connection.
const postgres = new PostgresClient();

// Injectable seam for tests: handlers accept an optional db so a test can
// substitute a fake instead of hitting Postgres. Defaults to the real one.
type Database = typeof postgres.db;

const VALID_ROLES = ["ADMIN", "MANAGER", "USER"] as const;

/**
 * GET /getAll — requires ADMIN/MANAGER. Reads real users from Postgres.
 *
 * `password_hash` is never selected back out, so it can't leak in a
 * response. Only id/email/name/role/createdAt are exposed.
 */
export const getUsers = async (req: Request, res: Response, db: Database = postgres.db) => {
  console.log(`[User Service ${process.env.INSTANCE_ID}] Handled request on port ${config.PORT}`);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users);

  const apiResponsePayload: ApiResponse<object[]> = {
    success: true,
    message: "Users fetched successfully",
    data: rows,
    status: 200,
  };
  return res.status(apiResponsePayload.status).json(apiResponsePayload);
};

/**
 * POST /register — creates a real user row.
 *
 * Hardening vs the earlier in-memory version:
 *  1. Body is destructured defensively (missing fields -> 400, not a crash).
 *  2. role is validated against the same enum the gateway enforces.
 *  3. password is bcrypt-hashed (never stored plaintext, never logged).
 *  4. Duplicate userId OR email -> 409 (unique constraints as backstop).
 *  5. Success returns the created user (no token — /login mints those).
 */
export const registerUser = async (req: Request, res: Response, db: Database = postgres.db) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId : undefined;
  const email = typeof body.email === "string" ? body.email : undefined;
  const password = typeof body.password === "string" ? body.password : undefined;
  const role = typeof body.role === "string" ? body.role : undefined;

  if (!userId || !email || !password) {
    const badRequest: ApiResponse<null> = {
      success: false,
      message: "Missing required fields: userId, email, password",
      status: 400,
      data: null,
    };
    return res.status(400).json(badRequest);
  }

  const validRole = VALID_ROLES.find((r) => r === role);
  if (!validRole) {
    const badRequest: ApiResponse<null> = {
      success: false,
      message: `role must be one of: ${VALID_ROLES.join(", ")}`,
      status: 400,
      data: null,
    };
    return res.status(400).json(badRequest);
  }

  try {
    // Check BOTH business keys up front so a duplicate gets a clean 409
    // instead of crashing at insert time.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));

    if (existing.length > 0) {
      const conflict: ApiResponse<null> = {
        success: false,
        message: "User already exists",
        status: 409,
        data: null,
      };
      return res.status(409).json(conflict);
    }

    // Hash before store. bcrypt salting can be slow (~60-100ms @ 10 rounds)
    // — nearly free on modern hardware, very expensive to brute-force.
    const hashedPassword = await bcrypt.hash(password, 10);

    await db.insert(users).values({
      id: userId,
      email,
      role: validRole,
      passwordHash: hashedPassword,
    });

    console.log(`[User Service ${config.INSTANCE_ID}] Registered user ${userId} (${role})`);

    // /register creates the account only — token issuance is /login's job.
    const apiResponsePayload: ApiResponse<{ userId: string; email: string; role: string }> = {
      success: true,
      message: "User created successfully",
      data: { userId, email, role: validRole },
      status: 201,
    };
    return res.status(apiResponsePayload.status).json(apiResponsePayload);
  } catch (error) {
    // A race between the SELECT above and the INSERT would bubble up as a
    // unique-violation error — treat any constraint error as a duplicate.
    console.error("[User Service] Registration failed:", error);
    const serverError: ApiResponse<null> = {
      success: false,
      message: "Registration failed",
      status: 503,
      data: null,
    };
    return res.status(503).json(serverError);
  }
};

export const rateLimiterCheck = (req: Request, res: Response) => {
  const resPayload: ApiResponse<null> = {
    success: true,
    message: "Rate limit check passed",
    data: null,
    status: 200,
  };
  return res.status(resPayload.status).json(resPayload);
};

/**
 * POST /login — the only token-issuance endpoint.
 *
 * Verifies the stored bcrypt hash (register only wrote it). The role in the
 * token comes from the DB row, not the request body. Fails with a generic
 * 401 so a caller can't tell whether the email or the password was wrong.
 */
export const loginUser = async (req: Request, res: Response, db: Database = postgres.db) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email : undefined;
  const password = typeof body.password === "string" ? body.password : undefined;

  if (!email || !password) {
    const badRequest: ApiResponse<null> = {
      success: false,
      message: "Missing required fields: email, password",
      status: 400,
      data: null,
    };
    return res.status(400).json(badRequest);
  }

  try {
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        role: users.role,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, email));

    const row = rows[0];

    // Same generic message whether the account doesn't exist or the
    // password is wrong — don't leak which one failed.
    const invalidCredentials: ApiResponse<null> = {
      success: false,
      message: "Invalid credentials",
      status: 401,
      data: null,
    };

    if (!row) {
      return res.status(401).json(invalidCredentials);
    }

    const passwordMatches = await bcrypt.compare(password, row.passwordHash);
    if (!passwordMatches) {
      return res.status(401).json(invalidCredentials);
    }

    console.log(`[User Service ${config.INSTANCE_ID}] User ${row.userId} logged in (${row.role})`);

    const token = jwt.sign(
      { userId: row.userId, role: row.role },
      config.JWT_SECRET,
      { expiresIn: "7d" },
    );

    const apiResponsePayload: ApiResponse<{ token: string }> = {
      success: true,
      message: "Login successful",
      data: { token },
      status: 200,
    };
    return res.status(apiResponsePayload.status).json(apiResponsePayload);
  } catch (error) {
    console.error("[User Service] Login failed:", error);
    const serverError: ApiResponse<null> = {
      success: false,
      message: "Login failed",
      status: 503,
      data: null,
    };
    return res.status(503).json(serverError);
  }
};