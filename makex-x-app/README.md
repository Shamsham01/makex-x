# MakeX-X — X (Twitter) Custom App for Make.com

MakeX-X is a **Make.com custom app** that wraps the X (Twitter) API v2 through the MakeX backend at `https://makex-x.onrender.com`. It mirrors the **WARPS-App-MakeX** architecture: server-side Bearer protection, hybrid connection (X OAuth 2.0 PKCE + MultiversX PEM wallet), and a dedicated `POST /authorization` step.

**App ID (Make):** `makex-x-kj31eh`  
**Version:** 1.0.0

---

## Features

| Module | Description |
|--------|-------------|
| **Post** | Create posts with text and optional image, GIF, or video (multipart upload via backend) |
| **Get Post by ID** | Fetch a single post with metrics and metadata |
| **Get Replies** | List conversation replies with pagination |
| **Get Post Stats** | Engagement: likes, reposts, replies, quotes, bookmarks, impressions |
| **Search Posts** | Search by hashtag, username, or keyword |

---

## Architecture (same as WARPS)

```
Make Scenario
    │
    ▼
MakeX-X Custom App (Make)
    │  common.apiKey  → Bearer server token
    │  connection     → X OAuth 2.0 PKCE + pemContent (pkey)
    │
    ▼
https://makex-x.onrender.com
    │  POST /authorization  → validate wallet PEM (preauthorize)
    │  POST /post           → tweet + media upload
    │  POST /posts/get      → read post
    │  POST /posts/replies  → thread replies
    │  POST /posts/stats    → engagement
    │  POST /search         → hashtag / username / keyword
    │
    ▼
X API v2 (OAuth user context)
```

### Hybrid connection flow

1. **preauthorize** — `POST /authorization` with `walletPem` (same as WARPS `connection.api`)
2. **authorize** — X OAuth 2.0 with PKCE (`code_challenge` S256)
3. **token** — Exchange code at `https://api.x.com/2/oauth2/token`
4. **refresh** — Auto-refresh access token before expiry
5. **info** — `GET /2/users/me` for connection label (`@username`)

### Default OAuth scopes

- `tweet.read`, `tweet.write`, `users.read`, `offline.access`, `media.write`

---

## Credentials (Make vs Render)

See **[CREDENTIALS.md](../CREDENTIALS.md)** in the repo root.

**Short answer:** `clientId` / `clientSecret` → **Make.com Common data** (OAuth runs in Make). `SECURE_TOKEN` → **Render env** and **Make Common data** as `Bearer …` (must match).

---

## Prerequisites

1. **Make CLI** authenticated (`make-cli login`)
2. **X Developer App** with OAuth 2.0 enabled
   - Callback URL: `https://www.make.com/oauth/cb/app`
   - Type: Web App / Confidential client
3. **MakeX-X backend** deployed at `https://makex-x.onrender.com` with `SECURE_TOKEN` set
4. **MultiversX automation wallet** PEM for usage fees (REWARD + EGLD), same as other MakeX apps

---

## Developer setup

### 1. Configure common data

Copy `common.example.json` → `common.json`, then edit:

```json
{
  "apiKey": "Bearer YOUR_SECURE_TOKEN",
  "apiBaseUrl": "https://makex-x.onrender.com",
  "clientId": "YOUR_X_CLIENT_ID",
  "clientSecret": "YOUR_X_CLIENT_SECRET",
  "timeout": 300000
}
```

`apiKey` must include the `Bearer ` prefix — the API compares the full header to `Bearer ${SECURE_TOKEN}`.

### 2. Deploy to your Make account

```powershell
cd "makex-x-app"
node deploy.mjs
```

### 3. Validate only (no upload)

```powershell
node deploy.mjs --validate-only
```

---

## CLI commands reference

> **Windows note:** Use `--version=1` (not `--version 1`) — otherwise Commander prints the CLI version instead of running the command.

### Login (one-time)

```powershell
npm install -g @makehq/cli
make-cli login
make-cli whoami
```

### Create app (already done)

```powershell
make-cli sdk-apps create `
  --name makex-x `
  --label "MakeX-X" `
  --description "X API wrapper for Make.com" `
  --theme "#000000" `
  --language en `
  --audience global `
  --private
```

### Set common + base

```powershell
make-cli sdk-apps set-common --name=makex-x-kj31eh --version=1 --common="$(Get-Content common.json -Raw)"
make-cli sdk-apps set-section --name=makex-x-kj31eh --version=1 --section=base --body="$(Get-Content base.json -Raw)"
```

### Connection (OAuth + PEM)

```powershell
make-cli sdk-connections create --app-name=makex-x-kj31eh --type=oauth --label="X Account + MakeX Wallet"

make-cli sdk-connections set-section --connection-name=makex-x-kj31eh --section=parameters --body="$(Get-Content connection/parameters.json -Raw)"
make-cli sdk-connections set-section --connection-name=makex-x-kj31eh --section=scope --body="$(Get-Content connection/scopes.json -Raw)"
make-cli sdk-connections set-section --connection-name=makex-x-kj31eh --section=api --body="$(Get-Content connection/communication.json -Raw)"
```

### Modules

```powershell
# Example: Post module
make-cli sdk-modules create --app-name=makex-x-kj31eh --app-version=1 --name=postTweet --type-id=4 --label="Post" --module-init-mode=blank
make-cli sdk-modules set-section --app-name=makex-x-kj31eh --app-version=1 --module-name=postTweet --section=parameters --body="$(Get-Content modules/postTweet/parameters.json -Raw)"
make-cli sdk-modules set-section --app-name=makex-x-kj31eh --app-version=1 --module-name=postTweet --section=api --body="$(Get-Content modules/postTweet/communication.json -Raw)"
make-cli sdk-modules update --app-name=makex-x-kj31eh --app-version=1 --module-name=postTweet --connection=makex-x-kj31eh
```

Or run **`node deploy.mjs`** to push all sections at once.

### Validate

```powershell
make-cli sdk-apps get --name=makex-x-kj31eh --version=1
make-cli sdk-connections get --connection-name=makex-x-kj31eh
make-cli sdk-modules list --app-name=makex-x-kj31eh --app-version=1
node deploy.mjs --validate-only
```

### Package / publish

Make custom apps are **not packaged as zip files**. “Deploy” means uploading JSON sections via the CLI (or editing in the Make Developer Hub). To share:

1. Open **Make → Developer Hub → Custom Apps → MakeX-X**
2. Test modules in the scenario builder
3. Generate an **invitation link** when ready to share (or request app review for public listing)

---

## End-user installation guide

### Step 1 — Install the app

1. Open the MakeX-X invitation link from your administrator (or find **MakeX-X** under Custom Apps in your Make zone).
2. Click **Add** / **Install**.

### Step 2 — Create a connection

1. In any scenario, add a **MakeX-X** module (e.g. **Post**).
2. Click **Add connection**.
3. Fill in:
   - **PEM Content** — MultiversX wallet PEM for MakeX usage fees ([PEM Generator](https://makex-web3.com/pem-generator/))
   - Use a **dedicated automation wallet** with REWARD (usage fee) and EGLD (gas)
4. Complete **X OAuth** in the browser popup (authorize the app).
5. Connection shows as `@yourusername (Display Name)` when successful.

### Step 3 — Build scenarios

**Post with image**

1. Module: **MakeX-X → Post**
2. Map **Post Text**
3. Map **Media Data** from a previous module (Google Drive, HTTP, etc.)
4. Set **Media File Name** (e.g. `photo.jpg`)
5. Choose **Media Type**: Image / GIF / Video

**Get engagement**

1. Module: **MakeX-X → Get Post Stats**
2. Map **Post ID** from a prior Post module or webhook

**Search hashtag**

1. Module: **MakeX-X → Search Posts**
2. Search Type: **Hashtag**
3. Query: `#MakeX` or `MakeX`

---

## Error handling

Responses follow the MakeX standard envelope:

```json
{
  "status": "success | error",
  "code": "AUTHORIZATION_SUCCESS | INSUFFICIENT_REWARD_BALANCE | UNAUTHORIZED | ...",
  "message": "Human-readable message",
  "data": { }
}
```

| Code | Action |
|------|--------|
| `UNAUTHORIZED` | Fix `common.apiKey` / `SECURE_TOKEN` on the backend |
| `INSUFFICIENT_REWARD_BALANCE` | Top up REWARD-cf6eac on the connected MultiversX wallet |
| `INSUFFICIENT_EGLD_GAS` | Top up EGLD for network fees |
| OAuth errors | Re-authorize connection; confirm callback URL and scopes |

---

## Project structure

```
makex-x-app/
├── app.json                 # App metadata
├── common.json              # apiKey, apiBaseUrl, X client credentials
├── base.json                # baseUrl, headers, timeout, log sanitize
├── connection/
│   ├── parameters.json      # pemContent (pkey) + optional X overrides
│   ├── scopes.json          # Default OAuth scopes
│   └── communication.json   # preauthorize + OAuth PKCE + refresh + info
├── modules/
│   ├── postTweet/           # Multipart media + text
│   ├── getPostById/
│   ├── getReplies/
│   ├── getPostStats/
│   └── searchPosts/
├── deploy.mjs               # Push all sections to Make
└── README.md                # This file
```

---

## Security

- PEM private keys are stored in the user's Make connection (encrypted by Make), not on the MakeX server.
- Bearer `SECURE_TOKEN` protects backend endpoints from unauthorized access.
- OAuth tokens are stored in the connection; logs sanitize `authorization`, `walletPem`, and tokens.
- Use a dedicated automation wallet with limited funds.

---

## Support

- Backend API: `https://makex-x.onrender.com/health`
- MakeX PEM tool: https://makex-web3.com/pem-generator/
- X API docs: https://docs.x.com/x-api
