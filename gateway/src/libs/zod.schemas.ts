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
  password: z.string(),
  role: z.enum(["ADMIN", "MANAGER","USER"])
});

export const loginUserSchema = z.object({
  email: z.email(),
  password: z.string(),
});

export const paymentTxSchema = z.object({
  amount: z.number().positive(),
});
