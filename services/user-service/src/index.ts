import express from "express";
import dotenv from "dotenv";
import { getUsers } from "./controllers/user.controllers.js";
dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3001");

app.get("/api/v1/users", getUsers);

app.listen(PORT, () => {
  console.log(`User Service ${process.env.INSTANCE_ID} running internally on port ${PORT}`)
})