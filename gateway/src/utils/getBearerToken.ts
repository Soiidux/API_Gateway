/**
 * getBearerToken — extracts the raw JWT from an Express request's
 * `Authorization` header. Returns the token string only when the header
 * is present AND uses the `Bearer ` scheme; returns `undefined` otherwise.
 *
 * NOTE: `authHeader.slice(7)` is correct here because `"Bearer "` is
 * exactly 7 characters — it skips the scheme prefix, leaving the token.
 */

import type { Request } from "express"; 

export function getBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return undefined;
  }
  return authHeader.slice(7);
}