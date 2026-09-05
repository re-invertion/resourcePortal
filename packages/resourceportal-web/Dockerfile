FROM node:24-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/resourceportal-api/package.json ./packages/resourceportal-api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
COPY packages/resourceportal-sdk/package.json ./packages/resourceportal-sdk/package.json
COPY packages/resourceportal-web/package.json ./packages/resourceportal-web/package.json
RUN npm ci --workspace @resource-portal/web --include-workspace-root=false

FROM node:24-alpine AS production-dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/resourceportal-api/package.json ./packages/resourceportal-api/package.json
COPY packages/resourceportal-cli/package.json ./packages/resourceportal-cli/package.json
COPY packages/resourceportal-sdk/package.json ./packages/resourceportal-sdk/package.json
COPY packages/resourceportal-web/package.json ./packages/resourceportal-web/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @resource-portal/web --include-workspace-root=false

FROM node:24-alpine AS build
WORKDIR /app/packages/resourceportal-web

COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=dependencies /app/packages/resourceportal-web/node_modules ./node_modules
COPY packages/resourceportal-web/package.json ./package.json
COPY packages/resourceportal-web/tsconfig.json ./tsconfig.json
COPY packages/resourceportal-web/vite.config.ts ./vite.config.ts
COPY packages/resourceportal-web/index.html ./index.html
COPY packages/resourceportal-web/server.mjs ./server.mjs
COPY packages/resourceportal-web/proxy-target.mjs ./proxy-target.mjs
COPY packages/resourceportal-web/src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app/packages/resourceportal-web

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5173

COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/packages/resourceportal-web/node_modules ./node_modules
COPY --from=build /app/packages/resourceportal-web/package.json ./package.json
COPY --from=build /app/packages/resourceportal-web/server.mjs ./server.mjs
COPY --from=build /app/packages/resourceportal-web/proxy-target.mjs ./proxy-target.mjs
COPY --from=build /app/packages/resourceportal-web/dist ./dist

USER node
EXPOSE 5173
CMD ["node", "server.mjs"]
