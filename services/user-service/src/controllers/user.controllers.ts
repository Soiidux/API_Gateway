import type { Request, Response } from "express";
import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";

interface ApiResponse<T>{
  success: boolean;
  message: string;
  status: number;
  data: T
}

export const getUsers = (req: Request, res: Response) => {
  console.log(`[User Service ${process.env.INSTANCE_ID}] Handled request on port ${process.env.PORT || 3001}`);
  const apiResponsePayload: ApiResponse<{ id: string, name: string }[]> = {
    success: true,
    message: 'Users fetched successfully',
    data: [{
      id: "1", name: "Yash"
    }, {
      id: "2", name: "Nagpal"
    }],
    status: 200
  };
  return res.status(apiResponsePayload.status).json(apiResponsePayload);
}

export const registerUser = (req: Request, res: Response) => {
  console.log("registration hit");
  const { userId, email, role, password } = req.body;
  console.log(userId, email, role, password);
  const token = jwt.sign({ userId, role }, process.env.JWT_SECRET!, { expiresIn: '7d' });
  console.log("token", token);
  const apiResponsePayload: ApiResponse<string> = {
    success: true,
    message: 'User created successfully',
    data: token,
    status: 201
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