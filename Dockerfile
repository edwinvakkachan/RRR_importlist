# ---------- Dockerfile ----------
# Use official lightweight Node.js image
FROM node:22-alpine AS base

# Set working directory
WORKDIR /app

# Copy only package files first (for caching)
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy all app source files
COPY . .

# Install lightweight process manager & parallel runner
RUN npm install -g concurrently dumb-init

# Expose web server port
EXPOSE 3000

# Health check (optional)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD wget -qO- http://localhost:3000/ || exit 1

# Start both server.js and bot.js concurrently
CMD ["dumb-init", "concurrently", "node server.js", "node bot.js"]
