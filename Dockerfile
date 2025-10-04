FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN npm install -g concurrently dumb-init
EXPOSE 3000
CMD ["dumb-init", "concurrently", "node server.js", "node bot.js"]
