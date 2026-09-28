ARG NODE_IMAGE=node:24-bookworm-slim
ARG INSTALL_GIT=1
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

ARG INSTALL_GIT
RUN if [ "$INSTALL_GIT" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY package.json package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config ./config
COPY scripts ./scripts

RUN useradd --create-home --uid 10001 skillhub \
    && mkdir -p /var/lib/team-skill-hub /skills \
    && chown -R skillhub:skillhub /app /var/lib/team-skill-hub /skills

USER skillhub

ENV HOST=0.0.0.0
ENV PORT=8080
ENV CONFIG_PATH=/app/config/repositories.yaml
ENV DATA_DIR=/var/lib/team-skill-hub

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
