
## Web projects (serve and url)

This is a web project, so `commands.serve` and `commands.url` are REQUIRED (set both).

- `serve`: starts the app in the foreground (it must not exit) on a fixed port, and binds to `0.0.0.0` or `localhost` so the browser check can reach it (for example `npm run dev -- --host 0.0.0.0 --port 3000`).
- `url`: where the app listens, as `http://localhost:<port>` or `http://127.0.0.1:<port>`, optionally with a path. The port must match `serve`.
