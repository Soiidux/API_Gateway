FROM node:20-alpine

WORKDIR /app

# 1. Install dependencies first
COPY package*.json ./
RUN npm install

# 2. Copy the rest of the source files (including tsconfig.json)
COPY . .

# 3. Compile the TypeScript source code into the dist/ directory
RUN npm run build

# 4. Expose the port the gateway listens on
EXPOSE 3000

# 5. Boot up the compiled JavaScript gateway
CMD ["npm", "start"]