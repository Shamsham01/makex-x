# Where credentials live

## Split: Make.com vs Render

| Secret | Where | Why |
|--------|--------|-----|
| **SECURE_TOKEN** | **Render** env var | Backend validates `Authorization: Bearer …` on every module call |
| **apiKey** (`Bearer …`) | **Make → Common data** | Must be `Bearer ` + the same `SECURE_TOKEN` value |
| **apiBaseUrl** | **Make → Common data** | Your Render service URL, e.g. `https://makex-x.onrender.com` |
| **clientId** | **Make → Common data** | X OAuth authorize + token exchange (connection communication) |
| **clientSecret** | **Make → Common data** | X OAuth token/refresh (Basic auth header in connection) |
| **pemContent** | **Make → Connection** (per user) | User wallet PEM; never stored in Render env |
| **accessToken / refreshToken** | **Make → Connection** (per user) | From X OAuth; sent to backend per request in module body |

### X Client ID / Secret — Make, not Render

OAuth runs **inside Make** when the user creates a connection (`authorize` → `token` → `refresh` in `connection/communication.json`). The backend receives **already-issued** `accessToken` / `refreshToken` from each module call. You do **not** need `X_CLIENT_ID` or `X_CLIENT_SECRET` on Render unless you later add server-side OAuth outside Make.

Set them in **Developer Hub → MakeX-X → Common data** (or copy `makex-x-app/common.example.json` → `common.json`, fill in, run `node deploy.mjs`).

### SECURE_TOKEN — both sides

1. Generate a long random string.
2. **Render:** Environment → `SECURE_TOKEN` = that string (see `.env.example`).
3. **Make:** Common data → `"apiKey": "Bearer <same string>"` (include the `Bearer ` prefix).

After Render deploy, set **apiBaseUrl** in Make common data to your live URL (e.g. `https://makex-x-xxxx.onrender.com`).

## Render `.env` / dashboard

Use `.env.example` as reference. Required on Render:

```
SECURE_TOKEN=...
CURRENT_URL=https://your-service.onrender.com
PORT=10000
```

Optional (usage-fee whitelist, same as WARPS):

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

## Local development

```powershell
copy .env.example .env
copy makex-x-app\common.example.json makex-x-app\common.json
# Edit both with matching SECURE_TOKEN and your X app credentials (Make file only for X)
npm install
npm start
node makex-x-app\deploy.mjs
```

## Never commit

- `.env`
- `makex-x-app/common.json` (gitignored; use `common.example.json`)
- Real PEM files or API keys in any tracked file
