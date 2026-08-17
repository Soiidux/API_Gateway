# The payment-service image (accounts + transactions). Like user-service,
# docker-compose runs three replicas of it (payment-service-1/2/3) share
# one database; replica INSTANCE_ID=1 owns the migration at boot.
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3002

CMD ["npm", "start"]

