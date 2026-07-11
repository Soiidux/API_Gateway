import { z } from "zod";

export const registerUserSchema = z.object({
  userId: z.string(),
  email: z.email(),
  password: z.string(),
  role: z.enum(["ADMIN", "MANAGER","USER"])
});
