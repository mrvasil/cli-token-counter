FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4173

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY .env ./

USER node

EXPOSE 4173

CMD ["node", "server.js"]
