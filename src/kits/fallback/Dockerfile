# Fallback kit: generic Node + Python toolchain with the Anton agent entry at /opt/anton.
# Build context is this directory. `npm run build:image` stages dist/agent/{entry,protocol}.js
# and a minimal package.json into .stage/ (gitignored) before running `docker build`.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git \
 && rm -rf /var/lib/apt/lists/*

# Production deps are installed inside the image, not copied from the host:
# the Agent SDK pulls a platform-specific Claude Code binary (linux-*), via optionalDependencies.
WORKDIR /opt/anton
COPY .stage/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY .stage/entry.js .stage/protocol.js ./

# The container runs as root. Claude Code allows bypassPermissions as root only inside a sandbox.
ENV IS_SANDBOX=1
WORKDIR /workspace
