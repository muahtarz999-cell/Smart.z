FROM node:22-bookworm-slim

WORKDIR /srv/whatsapp
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "src/server.js"]