FROM node:24-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/resourceportal-api/package.json ./packages/resourceportal-api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
COPY packages/resourceportal-sdk/package.json ./packages/resourceportal-sdk/package.json
RUN npm ci --workspace @resource-portal/api --include-workspace-root=false

FROM node:24-alpine AS production-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/resourceportal-api/package.json ./packages/resourceportal-api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
COPY packages/resourceportal-sdk/package.json ./packages/resourceportal-sdk/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @resource-portal/api --include-workspace-root=false

FROM node:24-alpine AS build
WORKDIR /app/packages/resourceportal-api

COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/packages/resourceportal-api/node_modules ./node_modules
COPY package.json package-lock.json /app/
COPY packages/resourceportal-api/package.json ./
COPY packages/resourceportal-api/nest-cli.json packages/resourceportal-api/tsconfig.json packages/resourceportal-api/tsconfig.build.json ./
COPY packages/resourceportal-api/prisma ./prisma
COPY packages/resourceportal-api/scripts ./scripts
COPY packages/resourceportal-api/src ./src

RUN npm run prisma:generate
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app/packages/resourceportal-api

ENV NODE_ENV=production

# The image stays non-root by default. The production operation-worker may
# override the user to root on the storage node so only that process can
# mutate filesystem project quotas.
RUN apk add --no-cache \
    docker-cli \
    e2fsprogs-extra \
    findmnt \
    quota-tools \
    xfsprogs-extra

COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/packages/resourceportal-api/node_modules ./node_modules
COPY --from=build /app/packages/resourceportal-api/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/packages/resourceportal-api/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/resourceportal-api/package.json ./package.json
COPY --from=build /app/packages/resourceportal-api/dist ./dist
COPY --from=build /app/packages/resourceportal-api/prisma ./prisma

USER node

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
