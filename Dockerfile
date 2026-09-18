# SHIPMATE, for a host with a stable URL.
#
# n8n Cloud calls this service over the public internet, so it has to live somewhere with
# a hostname that does not expire. That rules out a quick-tunnel — agents 717, 758 and 1182
# have each been wired to a trycloudflare host that has since died, and repeating it here
# would just move the failure one layer down.
#
# Render, Railway and Fly all work. Build:
#   docker build -t araxys-shipmate .
#   docker run -p 8788:8788 --env-file .env araxys-shipmate

FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source edit does not reinstall node_modules on every build.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# tsx runs TypeScript directly. No build step to drift out of sync with source, which for
# a service this size is worth more than the startup milliseconds a compile would save.
RUN npm install tsx --no-save

ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

# No secret is baked in. SHIPMATE_API_SECRET comes from the host's environment, and the
# service refuses to start without it — see the header of src/http/server.ts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:8788/health || exit 1

CMD ["npx", "tsx", "src/http/server.ts"]
