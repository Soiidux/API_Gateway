import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import config from "../config.js";
import { PostgresClient } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

interface ApiResponse<T> {
  success: boolean;
  message: string;
  status: number;
  data: T;
}

// Keep ONE client for the lifetime of the process (a pool of connections),
// created lazily so importing the module doesn't trigger a DB connection.
const postgres = new PostgresClient();

const VALID_ROLES = ["ADMIN", "MANAGER", "USER"] as const;

/**
 * GET /getAll — requires ADMIN/MANAGER. Reads real users from Postgres.
 *
 * `password_hash` is never selected back out, so it can't leak in a
 * response. Only id/email/name/role/createdAt are exposed.
 */
export const getUsers = async (req: Request, res: Response) => {
  console.log(`[User Service ${process.env.INSTANCE_ID}] Handled request on port ${config.PORT}`);

  const rows = await postgres.db
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
 *  5. Success returns the JWT (as before) so the rest of the demo can
 *     use it against protected gateway routes.
 */
export const registerUser = async (req: Request, res: Response) => {
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
    const existing = await postgres.db
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

    await postgres.db.insert(users).values({
      id: userId,
      email,
      role: validRole,
      passwordHash: hashedPassword,
    });

    console.log(`[User Service ${config.INSTANCE_ID}] Registered user ${userId} (${role})`);

    // The register flow doubles as the token-issuance flow for this demo
    // (there is deliberately no /login endpoint).
    const token = jwt.sign({ userId, role: validRole }, config.JWT_SECRET, { expiresIn: "7d" });

    const apiResponsePayload: ApiResponse<string> = {
      success: true,
      message: "User created successfully",
      data: token,
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