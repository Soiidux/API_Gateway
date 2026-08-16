import type { Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import generateApiResponse from "../utils/generateApiResponse.js";
            
const validateBody = (bodySchemas: Record<string, z.ZodSchema> = {}) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const matchingKey = Object.keys(bodySchemas).find(
        routeKey => req.path === routeKey || req.path.startsWith(`${routeKey}/`),
      );
      
      if (!matchingKey) {
        // no schema registered for this route -> skip validation, let it pass through
        return next();
      }
      const schema = bodySchemas[matchingKey]
      const result = await schema?.safeParseAsync(req.body);
      if (!result?.success) {
        const responsePayload : ApiResponse<null> = generateApiResponse<null>(null, "Bad Request: " + result?.error.issues.map(issue => issue.message).join(", "), 400)
        return res.status(responsePayload.status).json(responsePayload);
      }
      req.body = result.data;
      next();
    } catch (error) {
      // Defensive catch; zod's safeParseAsync never throws on bad data.
      // Log the real error server-side, send a generic message — don't
      // leak internals to the caller.
      console.error("validateBody unexpected error:", error);
      const responsePayload : ApiResponse<null> = generateApiResponse<null>(null, "Internal Server Error", 500)
      return res.status(responsePayload.status).json(responsePayload);
    }
  };
};

export default validateBody;