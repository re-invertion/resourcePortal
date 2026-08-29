FROM node:24-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
RUN npm ci --workspace @resource-portal/api --include-workspace-root=false

FROM node:24-alpine AS production-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @resource-portal/api --include-workspace-root=false

FROM node:24-alpine AS build
WORKDIR /app/apps/api

COPY --from=dependencies /app/node_modules /app/node_modules
COPY package.json package-lock.json /app/
COPY apps/api/package.json ./
COPY apps/api/nest-cli.json apps/api/tsconfig.json apps/api/tsconfig.build.json ./
COPY apps/api/prisma ./prisma
COPY apps/api/scripts ./scripts
COPY apps/api/src ./src

RUN npm run prisma:generate
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app/apps/api

ENV NODE_ENV=production

RUN apk add --no-cache docker-cli

COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client /app/node_modules/@prisma/client
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/apps/api/package.json ./package.json
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/prisma ./prisma

USER node

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
