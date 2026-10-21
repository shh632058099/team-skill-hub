FROM node:24-bookworm-slim

ARG CODEX_VERSION=0.162.1

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

# Codex uses a native TLS client; include the system trust store in the
# runtime image rather than relying on Node.js' bundled CA certificates.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 expert

COPY entrypoint.sh /usr/local/bin/expert-codex-entrypoint
RUN chmod 0755 /usr/local/bin/expert-codex-entrypoint

USER expert
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/expert-codex-entrypoint"]
CMD ["--version"]
