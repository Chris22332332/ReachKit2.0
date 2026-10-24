FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 REACHKIT_DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./server.js
COPY drafting.js ./drafting.js
COPY email-service.js ./email-service.js
COPY sms-service.js ./sms-service.js
COPY x-service.js ./x-service.js
COPY migrations ./migrations
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
