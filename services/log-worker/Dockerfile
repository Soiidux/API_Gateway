# The log pipeline's CONSUMER side. Runs as a single container (no
# replicas) and does not serve HTTP: it waits on the RabbitMQ
# "api_gateway_logs" queue, drains it in batches, and bulk-inserts log
# rows into Postgres. Docker-compose starts this with RABBITMQ_URL +
# DATABASE_URL injected.
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

CMD ["npm", "start"]