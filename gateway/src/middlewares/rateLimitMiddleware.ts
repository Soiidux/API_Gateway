/**
 * Rate limit middleware that uses Redis to limit the number of requests per user or IP.
 */

import type { Request, Response, NextFunction } from "express";
import { authenticatedRateLimiter, anonymousRateLimiter } from "../utils/rateLimiter/rateLimiterInstances.js";
import generateApiResponse from "../utils/generateApiResponse.js";


const rateLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.headers["x-user-id"] as string | undefined;                                //1.  Get the user ID from the request headers
  
  const isAuthenticated = userId !== undefined;                                                 
  const rateLimiter = isAuthenticated ? authenticatedRateLimiter : anonymousRateLimiter;        //2.  Get the rate limiter based on authentication status
  const key : string = isAuthenticated ? `ratelimit:user:${userId}` : `ratelimit:ip:${req.ip}`;  //3.  Generate the rate limit key based on authentication status
  try {
    const allowed: boolean = await rateLimiter.allow(key);                                      //4.  Check if the request is allowed based on the rate limiter
    if (!allowed) {
      const responsePayload : ApiResponse<null> = generateApiResponse(null, "Too Many Requests", 429); //5.  Send 429 Too Many Requests if the request is not allowed
      return res.status(responsePayload.status).json(responsePayload);
    }
    next(); //6.  Proceed to the next middleware if the request is allowed
  } catch (error) {
    console.error("Rate limit error:", error); // In case of an error, log it and pass it to the next middleware
    next(error);
  }
}

export default rateLimitMiddleware;
