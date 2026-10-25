FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . ./
ENV NODE_ENV=production DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "bot-entry.js"]
