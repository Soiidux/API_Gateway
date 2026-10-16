/**
 * conditionalAuth — JWT + RBAC gate for proxied routes.
 *
 * Runs for every request on a service path and does one of three things:
 *   1. Allows it through untouched if it matches a public route
 *      (e.g. `/register`), or
 *   2. Requires a valid `Authorization: Bearer <token>` signed with
 *      JWT_SECRET, then checks the decoded role against the route's
 *      `roleMap` entry, or — for non-roleMap routes — the service's
 *      `defaultRoles`, or
 *   3. Rejects with 401/403 via generateApiResponse.
 *
 * The verified identity is attached to the request as headers
 * (`x-user-id`, `x-user-role`) and forwarded to the backend service,
 * which re-verifies the JWT itself (auth is enforced at both hops).
 *
 * IMPORTANT GOTCHA: an empty `defaultRoles: []` is NOT "public" — it is
 * "forbidden for everyone", because `[].includes(role)` is always false.
 * Services that should be reachable by any logged-in user must list the
 * roles explicitly (see the payment service's proxy config).
 *
 * SECURITY — why this middleware STRIPS x-user-* on the way in:
 *
 * Downstream middleware trusts these headers to mean "a verified JWT said
 * so":
 *   - rateLimitMiddleware picks its bucket from `x-user-id` (authenticated
 *     20 tokens/refill 5/s vs anonymous 2/refill 1/s);
 *   - cacheKey scopes cached responses by `x-user-id`.
 *
 * But HTTP headers are caller-controlled. If we only ever *overwrite* them
 * on the authenticated path, a client can send its own `x-user-id` on a
 * PUBLIC route — where we return early, before ever touching the header —
 * and be treated as a logged-in user. That let anyone sidestep the
 * anonymous rate limit entirely, and rotating the header per request got a
 * fresh bucket each time, so unlimited throughput against endpoints that
 * bcrypt-hash passwords. A free DoS.
 *
 * So we delete both headers FIRST, unconditionally, before any branching.
 * After that line they can only exist because a verified token set them.
 * Public routes therefore carry no identity at all, which is what makes the
 * anonymous bucket the correct (and enforceable) one for them.
 */

import type { Request, Response, NextFunction } from "express";
import config from "../config.js";
import { getBearerToken } from "../utils/getBearerToken.js";
import generateApiResponse from "../utils/generateApiResponse.js";
import { isRevoked } from "../utils/tokenRevocation.js";
import jwt from "jsonwebtoken";


const conditionalAuth = (publicRoutes: string[] = [], roleMap: Record<string, string[]> = {}, defaultRoles: string[] = []) => {
  // `async` because the revocation check awaits a Redis lookup. Express 4 does
  // NOT catch async middleware rejections, but the body below is wrapped in
  // try/catch so no rejection can escape — the only throw path (jwt.verify) is
  // caught in-handler.
  return async (req: Request, res: Response, next: NextFunction) => {

    // Strip caller-supplied identity headers BEFORE any branching below —
    // including before the public-route early return, which is exactly where
    // a forged header used to survive. After this, these headers can only
    // exist because a verified JWT set them. See the SECURITY note above.
    delete req.headers["x-user-id"];
    delete req.headers["x-user-role"];

    // Check if the request path is a public route
    if (publicRoutes.some(r => req.path === r || req.path.startsWith(`${r}/`))) {
      return next();
    }

    try {
      //Check if token is present
      const token = getBearerToken(req);
      if (!token) {
        const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Unauthorized", 401);
        return res.status(responsePayload.status).json(responsePayload);
      }

      //Decode the token (throws on missing/expired/bad-signature -> caught below as 401)
      // `iat` is added automatically by jsonwebtoken and is what the
      // revocation check compares against a user's logout time.
      const decoded : { userId: string, role: string, iat?: number } =
        jwt.verify(token, config.JWT_SECRET) as { userId: string, role: string, iat?: number };

      // A valid signature is necessary but NOT sufficient: the user may have
      // logged out since this token was minted, and a JWT can't be un-issued.
      // So consult the revocation store before trusting the role in it.
      //
      // Fails open if Redis is unreachable (see utils/tokenRevocation.ts) —
      // bounded by TOKEN_TTL, since an unrevoked token still expires on time.
      if (await isRevoked(decoded.userId, decoded.iat)) {
        const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Unauthorized", 401);
        return res.status(responsePayload.status).json(responsePayload);
      }

      //Check if the user has the required role
      // 1. Scan the roleMap keys to see if the incoming route matches or starts with a protected path
      const matchingRuleKey = Object.keys(roleMap).find(routeKey => {
              return req.path === routeKey || req.path.startsWith(`${routeKey}/`);
            });
      const requiredRoles = matchingRuleKey ? roleMap[matchingRuleKey] : defaultRoles;
      if (requiredRoles && !requiredRoles.includes(decoded.role)) {
        const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Forbidden", 403);
        return res.status(responsePayload.status).json(responsePayload);
      }

      // Attach the verified userId and role as headers. Safe to set here
      // because the forged copies were deleted at the top of this function.
      req.headers["x-user-id"] = decoded.userId;
      req.headers["x-user-role"] = decoded.role;

      next();
      
    } catch (error) {
      console.error(error);
      const responsePayload: ApiResponse<null> = generateApiResponse<null>(null, "Unauthorized", 401);
      return res.status(responsePayload.status).json(responsePayload);
    }
  };
}

export default conditionalAuth;