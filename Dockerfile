ARG RP_NODE_BASE_IMAGE=node:24-alpine
FROM ${RP_NODE_BASE_IMAGE} AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/postinstall-prisma.mjs ./scripts/postinstall-prisma.mjs
COPY packages/resourceportal-api/package.json ./packages/resourceportal-api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
COPY packages/resourceportal-sdk/package.json ./packages/resourceportal-sdk/package.json
COPY packages/resourceportal-help/package.json ./packages/resourceportal-help/package.json
# Root postinstall generates the API Prisma Client, so the schema must exist
# before npm ci runs in this dependency stage.
COPY packages/resourceportal-api/prisma ./packages/resourceportal-api/prisma
RUN npm ci --workspace @resource-portal/api --include-workspace-root=false

FROM ${RP_NODE_BASE_IMAGE} AS production-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/resourceportal-api/package.json ./packages/resourceportal-api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
COPY packages/resourceportal-sdk/package.json ./packages/resourceportal-sdk/package.json
COPY packages/resourceportal-help/package.json ./packages/resourceportal-help/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @resource-portal/api --include-workspace-root=false

FROM ${RP_NODE_BASE_IMAGE} AS build
WORKDIR /app/packages/resourceportal-api

COPY --from=dependencies /app/node_modules /app/node_modules
COPY package.json package-lock.json /app/
COPY packages/resourceportal-api/package.json ./
COPY packages/resourceportal-api/nest-cli.json packages/resourceportal-api/tsconfig.json packages/resourceportal-api/tsconfig.build.json ./
COPY packages/resourceportal-api/prisma ./prisma
COPY packages/resourceportal-api/scripts ./scripts
COPY packages/resourceportal-api/src ./src
COPY packages/resourceportal-help /app/packages/resourceportal-help

RUN npm run prisma:generate
RUN npm run build

FROM ${RP_NODE_BASE_IMAGE} AS runtime
LABEL org.opencontainers.image.source="https://github.com/re-invertion/resourcePortal"
WORKDIR /app/packages/resourceportal-api

ENV NODE_ENV=production

# The image stays non-root by default. The production ResourcePortal Worker
# overrides the user on the authoritative storage/control-plane node because
# infrastructure Operations include Docker and filesystem quota mutations.
RUN apk add --no-cache \
    bash \
    ca-certificates \
    curl \
    jq \
    openssl \
    docker-cli \
    iptables \
    iproute2 \
    wireguard-tools \
    e2fsprogs-extra \
    findmnt \
    quota-tools \
    xfsprogs-extra

COPY --chown=node:node --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=build /app/node_modules/.prisma /app/node_modules/.prisma
# Prisma CLI is a production dependency, but production npm ci runs with --ignore-scripts.
# Copy the pre-fetched engine bundle from the dependency stage so migrate deploy works offline.
COPY --from=dependencies /app/node_modules/@prisma/engines /app/node_modules/@prisma/engines
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/packages/resourceportal-api/package.json ./package.json
COPY --from=build /app/packages/resourceportal-api/dist ./dist
COPY --from=build /app/packages/resourceportal-api/prisma ./prisma
COPY --chown=node:node packages/resourceportal-web/public/brand ./brand
COPY --from=build /app/packages/resourceportal-help/package.json /app/packages/resourceportal-help/package.json
COPY --from=build /app/packages/resourceportal-help/dist /app/packages/resourceportal-help/dist
COPY --chown=root:root resourceportal-install.sh /app/resourceportal-installer/resourceportal-install.sh
COPY --chown=root:root scripts/installer /app/resourceportal-installer/scripts/installer
COPY --chown=root:root config/production /app/resourceportal-installer/config/production

USER node

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
