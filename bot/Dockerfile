FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

USER node

CMD ["node", "src/index.js"]
