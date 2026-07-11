import express from "express";
import dotenv from "dotenv";
import { getPayments } from "./controllers/payment.controllers.js";
dotenv.config();

const app = express();
app.use(express.json());
const PORT = parseInt(process.env.PORT || "3002");

app.get("/getAll", getPayments);

app.listen(PORT, () => {
  console.log(`Payment Service ${process.env.INSTANCE_ID} running internally on port ${PORT}`)
})