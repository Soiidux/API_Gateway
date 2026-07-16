import type { Request, Response } from "express";
import dotenv from "dotenv";
dotenv.config();

interface ApiResponse<T>{
  success: boolean;
  message: string;
  status: number;
  data: T
}

export const getPayments = (req: Request, res: Response) => {
  console.log(`[Payment Service ${process.env.INSTANCE_ID}] Handled request on port ${process.env.PORT || 3002}`);
  
  const apiResponsePayload: ApiResponse<{ id: number, userId: number, amount:number }[]> = {
    success: true,
    message: 'Payments fetched successfully',
    data: [{
      id: 1, userId: 1, amount:100
    }, {
      id: 2, userId: 2, amount: 200
    }],
    status: 200
  };
  return res.status(apiResponsePayload.status).json(apiResponsePayload);
}

export const rateLimiterCheck = (req: Request, res: Response) => {
  const resPayload: ApiResponse<null> = {
    success: true,
    message: 'Rate limit check passed',
    data: null,
    status: 200
  };
  return res.status(resPayload.status).json(resPayload);
}