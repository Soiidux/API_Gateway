import express from "express";
import dotenv from "dotenv";
import { getPayments } from "./controllers/payment.controllers.js";
dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3002");

app.get("/api/v1/payments", getPayments);

app.listen(PORT, () => {
  console.log(`Payment Service ${process.env.INSTANCE_ID} running internally on port ${PORT}`)
})