import express from "express";
import dotenv from "dotenv";
import { getUsers, registerUser } from "./controllers/user.controllers.js";
dotenv.config();

const app = express();
app.use(express.json());
const PORT = parseInt(process.env.PORT || "3001");

app.get("/getAll", getUsers);
app.post("/register", registerUser);

app.listen(PORT, () => {
  console.log(`User Service ${process.env.INSTANCE_ID} running internally on port ${PORT}`)
})