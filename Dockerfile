FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=10000
# Sur free tier sans disque : ./data (persiste tant que l'instance vit)
ENV LAVE_AUTO_DATA_PATH=/app/data/lave-auto-state.json

RUN mkdir -p /app/data

EXPOSE 10000
CMD ["node", "server.js"]
