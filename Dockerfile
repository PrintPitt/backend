# Railway backend: faucet + tIDRX top-up + relayer + keeper + order bot. Build context = backend repo root.
# Node >= 23.6 runs .ts directly (type stripping); 26 = the version used for local tests.
# @printpitt/shared is installed from vendor/*.tgz (see scripts/sync-shared.sh), so the build needs no access to other repos.
FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "src/server.ts"]
