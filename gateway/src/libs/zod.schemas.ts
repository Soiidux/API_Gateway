/**
 * Shared Zod request-body schemas.
 *
 * The gateway validates incoming JSON bodies with these BEFORE forwarding
 * to a backend service (see `validateBody` middleware + each service's
 * `bodySchemas` in proxyUtil). They live here so the same shape is the
 * single source of truth across gateway routing config and tests.
 *
 *  - registerUserSchema : `/api/v1/users/register` (note: client supplies
 *    the role directly — a documented trade-off of the demo auth model)
 *  - loginUserSchema    : `/api/v1/users/login` (email + password only)
 *  - paymentTxSchema    : `/api/v1/payments/deposit` and `/withdraw`
 */
import { z } from "zod";

export const registerUserSchema = z.object({
  userId: z.string(),
  email: z.email(),
  // Password policy. A minimum length is the single highest-value control
  // against credential stuffing — bcrypt's cost only slows attackers who are
  // already guessing; a short password makes guessing cheap regardless.
  // Capped too, because bcrypt only considers the first 72 BYTES of input, so
  // an unbounded string silently ignores everything past that point (and the
  // user believes their long passphrase is fully protecting them).
  // zod's .max() counts characters, not bytes — the 72-byte rule is enforced
  // by bcrypt itself, this cap just keeps the promise honest.
  password: z.string().min(8, "password must be at least 8 characters").max(72, "password must be at most 72 characters"),
  role: z.enum(["ADMIN", "MANAGER","USER"])
});

export const loginUserSchema = z.object({
  email: z.email(),
  // No length policy here on purpose: login must accept whatever was
  // registered, including credentials created before the policy existed.
  // Enforcing a minimum at login would lock those users out of their own
  // account rather than helping them.
  password: z.string(),
});

export const paymentTxSchema = z.object({
  amount: z.number().positive(),
});
