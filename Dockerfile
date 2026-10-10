FROM node:24-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node --input-type=module -e "const response = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'); if (!response.ok) throw new Error('Unable to download the AWS RDS CA bundle'); const { writeFile } = await import('node:fs/promises'); await writeFile('/app/rds-global-bundle.pem', Buffer.from(await response.arrayBuffer()));"
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine

ENV NODE_ENV=dev PORT=8000 DATABASE_SSL_CA_PATH=/app/rds-global-bundle.pem
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/rds-global-bundle.pem ./rds-global-bundle.pem
USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]