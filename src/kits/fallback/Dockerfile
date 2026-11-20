# Fallback kit: generic Node + Python toolchain with the Anton agent entry at /opt/anton.
# Build context is this directory. `npm run build:image` stages dist/agent/{entry,pricing,protocol}.js
# plus the repo's package.json + package-lock.json into .stage/ (gitignored) before `docker build`.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv git \
 && rm -rf /var/lib/apt/lists/*

# Security scanners (pinned; checksums from each project's published checksum file).
# gitleaks 8.30.1 (gitleaks_8.30.1_checksums.txt), osv-scanner 2.7.1 (osv-scanner_SHA256SUMS), semgrep 1.186.0 (PyPI).
ARG TARGETARCH
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_AMD64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
ARG OSV_VERSION=2.7.1
ARG OSV_SHA256_AMD64=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8
ARG OSV_SHA256_ARM64=983d22fbad9724514e3fcc6acc83b5fa64c5ffa6b0d9f510028f22c1b223ff81
ARG SEMGREP_VERSION=1.186.0
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) GL_ARCH=x64;   GL_SHA="$GITLEAKS_SHA256_AMD64"; OSV_ARCH=amd64; OSV_SHA="$OSV_SHA256_AMD64" ;; \
      arm64) GL_ARCH=arm64; GL_SHA="$GITLEAKS_SHA256_ARM64"; OSV_ARCH=arm64; OSV_SHA="$OSV_SHA256_ARM64" ;; \
      *) echo "unsupported arch" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSL -o gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GL_ARCH}.tar.gz"; \
    echo "${GL_SHA}  gitleaks.tgz" | sha256sum -c -; \
    tar -xzf gitleaks.tgz gitleaks; install -m 0755 gitleaks /usr/local/bin/gitleaks; \
    curl -fsSL -o osv-scanner "https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}/osv-scanner_linux_${OSV_ARCH}"; \
    echo "${OSV_SHA}  osv-scanner" | sha256sum -c -; \
    install -m 0755 osv-scanner /usr/local/bin/osv-scanner; \
    rm -f gitleaks gitleaks.tgz osv-scanner
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" \
 && ln -s /opt/venv/bin/semgrep /usr/local/bin/semgrep
ENV PATH="/opt/venv/bin:${PATH}"

# The repo is bind-mounted at /workspace and owned by the host user, not root: without this, git
# (and gitleaks, which reads history through git) refuses it as a "dubious ownership" repository.
RUN git config --system --add safe.directory /workspace

# Production deps are installed inside the image from the lockfile, not copied from the host:
# the Agent SDK pulls a platform-specific Claude Code binary (linux-*) via optionalDependencies.
WORKDIR /opt/anton
COPY .stage/package.json .stage/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY .stage/entry.js .stage/pricing.js .stage/protocol.js ./

# The container runs as root. Claude Code allows bypassPermissions as root only inside a sandbox.
ENV IS_SANDBOX=1
WORKDIR /workspace
