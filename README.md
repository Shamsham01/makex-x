# MakeX-X

X (Twitter) API integration for **Make.com**, with a **Render** backend — same hybrid pattern as WARPS (Bearer + PEM wallet + OAuth).

| Part | Path | Deploy target |
|------|------|----------------|
| Backend API | `index.js` | [Render](https://render.com) (`render.yaml`) |
| Make custom app | `makex-x-app/` | Make Developer Hub (`node makex-x-app/deploy.mjs`) |

## Quick start

1. **Credentials** — read [CREDENTIALS.md](CREDENTIALS.md)
2. **Render** — connect this repo, set `SECURE_TOKEN`, deploy
3. **Make** — copy `makex-x-app/common.example.json` → `common.json`, set `apiBaseUrl` + matching `apiKey` + X OAuth credentials, run `node deploy.mjs`

Full module docs: [makex-x-app/README.md](makex-x-app/README.md)
