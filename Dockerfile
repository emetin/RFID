FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY contracts ./contracts
COPY data/templates ./data/templates
COPY db ./db
COPY docs ./docs
COPY public ./public
COPY src ./src

USER node
EXPOSE 8080

CMD ["node", "--disable-warning=ExperimentalWarning", "src/api/server.js"]
