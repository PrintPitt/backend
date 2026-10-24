# Backend Railway: faucet + top-up tIDRX + relayer + keeper + order bot. Build context = root repo backend.
# Node >= 23.6 menjalankan .ts langsung (type stripping); 26 = versi yang dipakai saat uji lokal.
# @printpitt/shared dipasang dari vendor/*.tgz (lihat scripts/sync-shared.sh), jadi build tidak butuh akses ke repo lain.
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
