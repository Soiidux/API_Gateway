# The user-service image. docker-compose builds the SAME image three
# times, one per replica (user-service-1/2/3), each injecting a different
# INSTANCE_ID so only replica #1 runs the schema migration at boot.
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3001

CMD ["npm", "start"]

