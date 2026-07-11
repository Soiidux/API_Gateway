import dotenv from "dotenv";
import getServiceUrls from "./utils/getServiceUrls.js";
dotenv.config();

const config: Config = {
  PORT: parseInt(process.env.PORT || "3000"),
  JWT_SECRET: process.env.JWT_SECRET || "",
  USER_SERVICE_URLS: process.env.USER_SERVICE_URLS ? getServiceUrls(process.env.USER_SERVICE_URLS) : [],
  PAYMENT_SERVICE_URLS: process.env.PAYMENT_SERVICE_URLS ? getServiceUrls(process.env.PAYMENT_SERVICE_URLS) : [],
}

export default config;
