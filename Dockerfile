FROM node:18-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --production

COPY server.js ./
COPY public ./public

EXPOSE 3000
CMD ["node", "server.js"]
