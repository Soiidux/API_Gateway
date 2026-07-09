import type { Request, Response } from "express";
import dotenv from "dotenv";
dotenv.config();

interface ApiResponse<T>{
  success: boolean;
  message: string;
  status: number;
  data: T
}

export const getUsers = (req: Request, res: Response) => {
  console.log(`[User Service ${process.env.INSTANCE_ID}] Handled request on port ${process.env.PORT || 3001}`);
  const apiResponsePayload: ApiResponse<{ id: number, name: string }[]> = {
    success: true,
    message: 'Users fetched successfully',
    data: [{
      id: 1, name: "Yash"
    }, {
      id: 2, name: "Nagpal"
    }],
    status: 200
  };
  return res.status(apiResponsePayload.status).json(apiResponsePayload);
}