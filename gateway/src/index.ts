import express from "express";
import cors from "cors";
import helmet from "helmet";
import proxyServices from "./utils/proxyUtil.js";


const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(helmet());


app.use(express.json());

proxyServices(app);


// Inside User/Payment Service index.ts (at the very bottom)
app.use((err: any, req: any, res: any, next: any) => {
  console.error("🔥 Gateway CRASHED:", err.stack || err);
  return res.status(500).json({
    success: false,
    message: "Internal Microservice Error",
    error: err.message
  });
});

app.listen(3000, () => {
  console.log("[Proxy] Gateway is running on port 3000");
});
