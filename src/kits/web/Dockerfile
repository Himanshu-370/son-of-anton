# Web kit: the fallback kit image plus Playwright + Chromium. `npm run build:image` passes BASE.
ARG BASE
FROM ${BASE}
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_PATH=/usr/local/lib/node_modules
# Call the global binary (not npx) so the browser build always matches the pinned 1.50.1.
RUN npm i -g playwright@1.50.1 && playwright install --with-deps chromium
