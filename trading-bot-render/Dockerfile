# ---- build the React app ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY shared ./shared
RUN npm run build

# ---- runtime: Express serves the API and the built dist/ ----
FROM node:22-alpine
ENV NODE_ENV=production PORT=8000 DATA_DIR=/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:8000/healthz || exit 1
CMD ["node", "server/index.js"]
