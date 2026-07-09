import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createProxyMiddleware, type Options } from "http-proxy-middleware";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(helmet());

const userReplicas = [
  "http://user-service-1:3001",
  "http://user-service-2:3001",
  "http://user-service-3:3001",
]

const paymentReplicas = [
  "http://payment-service-1:3002",
  "http://payment-service-2:3002",
  "http://payment-service-3:3002",
]

let userIndex = 0;
let paymentIndex = 0;

const userProxyOptions: Options = {
  router: () => {
    const target = userReplicas[userIndex];
    userIndex = (userIndex + 1) % userReplicas.length;
    console.log(`[Proxy] Forwarding /api/v1/users request to -> ${target}`);
    return target || userReplicas[0];
  },
  pathFilter: "/api/v1/users/**",
  target:userReplicas[0] || "http://user-service-1:3001",
  changeOrigin: true,
}

const paymentProxyOptions: Options = {
  router: () => {
    const target = paymentReplicas[paymentIndex];
    paymentIndex = (paymentIndex + 1) % paymentReplicas.length;
    console.log(`[Proxy] Forwarding /api/v1/payments request to -> ${target}`);
    return target || paymentReplicas[0];
  },
  pathFilter: "/api/v1/payments/**",
  target: paymentReplicas[0] || "http://payment-service-1:3002",
  changeOrigin: true,
}

app.use(createProxyMiddleware(userProxyOptions));
app.use(createProxyMiddleware(paymentProxyOptions));

app.listen(3000, () => {
  console.log("[Proxy] Gateway is running on port 3000");
});
