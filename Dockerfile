# ---------- Dockerfile ----------
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files first for caching
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy source code
COPY . .

# Install dumb-init via apk (smaller and faster) + concurrently via npm (local)
RUN apk add --no-cache dumb-init \
 && npm install concurrently --no-save

# Expose web port
EXPOSE 3000

# Use dumb-init for clean process handling
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Run both server and bot concurrently
CMD ["npx", "concurrently", "node server.js", "node bot.js"]
