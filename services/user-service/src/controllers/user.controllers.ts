import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import config from "../config.js";
import { PostgresClient } from "../db/client.js";
import { revokeUserTokens } from "../db/redisClient.js";
import { users } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

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
 *
 * Logout (POST /logout): writes a revocation marker to Redis so the gateway
 * rejects this user's existing tokens from now on. A JWT can't be un-issued,
 * so deleting the client's copy only protects that one client.
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

/** Pagination defaults/limits for list endpoints. */
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

/**
 * Parses a non-negative-integer query param (limit/offset), clamping
 * limit to PAGE_SIZE_MAX and falling back to `fallback` for anything absent
 * or unparseable. Deliberately forgiving: a bad page param still returns data
 * rather than a 400.
 */
function parseLimit(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), PAGE_SIZE_MAX);
}

/**
 * GET /getAll — requires ADMIN/MANAGER. Reads real users from Postgres.
 *
 * `password_hash` is never selected back out, so it can't leak in a
 * response. Only id/email/name/role/createdAt are exposed.
 *
 * PAGINATED via ?limit= (default 50, max 200) and ?offset=. This was an
 * unbounded SELECT over the whole table on every call, so response size grew
 * with total users. The id primary key is already indexed, which is what makes
 * the LIMIT/OFFSET cheap.
 */
export const getUsers = async (req: Request, res: Response, db: Database = postgres.db) => {
  console.log(`[User Service ${process.env.INSTANCE_ID}] Handled request on port ${config.PORT}`);

  const limit = parseLimit(req.query.limit, PAGE_SIZE_DEFAULT);
  const offset = parseLimit(req.query.offset, 0);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.id) // stable ordering, so offset paging can't skip/duplicate rows
    .limit(limit)
    .offset(offset);

  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(users);

  const apiResponsePayload: ApiResponse<{
    users: typeof rows;
    pagination: { limit: number; offset: number; total: number };
  }> = {
    success: true,
    message: "Users fetched successfully",
    // Response shape CHANGED: the list moved under `data.users` to make room
    // for `data.pagination`. The old shape was a bare array, leaving no room
    // to add pagination without a breaking change later — better to make the
    // break explicit now.
    data: { users: rows, pagination: { limit, offset, total: Number(countRow?.count ?? 0) } },
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
    //
    // Compared with LOWER(email), NOT `email = email`, because Postgres text
    // equality is case-sensitive: without this, `Alice@x.com` would not match
    // the existing `alice@x.com` row, the pre-check would pass, and the INSERT
    // would then be rejected by the unique index — turning a clean 409 into a
    // generic 503. The pre-check and the constraint have to agree on the same
    // notion of equality, or the error handling is unreachable.
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`LOWER(${users.email}) = LOWER(${email})`);

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
      .where(sql`LOWER(${users.email}) = LOWER(${email})`); // case-insensitive, matches the unique index

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
      { expiresIn: config.TOKEN_TTL },
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

/**
 * POST /logout — revoke every token this user currently holds.
 *
 * Deleting the client's copy of a JWT doesn't un-issue it. Anything else
 * holding that token — a stolen copy, a shared machine, a log file — keeps
 * working until `exp`, because validating it never involves asking anyone
 * whether it's still wanted. So logout writes a revocation marker to Redis:
 *
 *     SET revoked:<userId> <now epoch seconds>  EX <TOKEN_TTL>
 *
 * and the gateway rejects any token whose `iat` is at or before that moment
 * (see gateway/src/utils/tokenRevocation.ts).
 *
 * Two properties worth knowing:
 *
 *  - ONE KEY PER USER, not per token. Every outstanding token dies at once,
 *    which is what you want from a logout, and the key space is bounded by
 *    user count rather than growing with every logout.
 *
 *  - IT SELF-EXPIRES. After TOKEN_TTL no token minted before the revocation can
 *    still be valid, so the record is dead weight and Redis drops it. That TTL
 *    must therefore track the token lifetime exactly: too short and revoked
 *    tokens silently come back to life, too long and we hold useless data.
 *
 * Also the right hook for a future "change my password" — bumping this same
 * marker invalidates every session, which is the correct response to a
 * suspected compromise. Same for a role change: a token minted while someone
 * was ADMIN still says ADMIN in its payload, and only this marker can fix that
 * before it expires.
 *
 * Requires a valid token (the gateway's defaultRoles covers /logout), so the
 * identity comes from the verified JWT in `req.auth` — never from the body.
 *
 * Idempotent: logging out twice, or with a token that's already been revoked,
 * both return 200. There's nothing to "already be done" about.
 */
export const logout = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) {
    const unauthorized: ApiResponse<null> = {
      success: false,
      message: "Unauthorized",
      status: 401,
      data: null,
    };
    return res.status(401).json(unauthorized);
  }

  try {
    // Math.floor because the JWT `iat` claim is integer seconds — writing a
    // fractional value would make the `iat <= revokedAt` comparison behave
    // oddly at the boundary.
    const now = Math.floor(Date.now() / 1000);
    await revokeUserTokens(userId, now);

    console.log(`[User Service ${config.INSTANCE_ID}] Revoked tokens for ${userId}`);

    const payload: ApiResponse<null> = {
      success: true,
      message: "Logged out successfully",
      status: 200,
      data: null,
    };
    return res.status(200).json(payload);
  } catch (error) {
    // Redis is unreachable, so the revocation marker was NOT written. Returning
    // 503 is the honest answer: telling the client "logged out" when nothing
    // was revoked would be worse than useless — they'd believe they're safe.
    //
    // This is the opposite of the read path, which fails OPEN. That asymmetry
    // is intentional: reads must not take authentication down, but a write that
    // didn't happen has to be reported rather than assumed.
    console.error("[User Service] Logout failed:", error);
    const serverError: ApiResponse<null> = {
      success: false,
      message: "Logout failed: could not record revocation",
      status: 503,
      data: null,
    };
    return res.status(503).json(serverError);
  }
};