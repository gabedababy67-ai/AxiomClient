# Axiom Client Website

Original dark/purple Minecraft-client website with:

- Axiom branding and purple-A logo
- Responsive landing page
- Owner login
- Cryptographically random license-key generation
- Custom expiration duration
- Optional pre-binding to a client ID
- First-activation client-ID binding
- License expiration and revocation
- License unbinding from the owner panel
- Protected Windows/JAR download ticket after successful validation
- Minecraft-side `/api/license/check` endpoint
- PostgreSQL storage
- Render Blueprint (`render.yaml`)

## 1. Put your actual client file in the project

Copy your client JAR to:

`protected/Axiom-Client.jar`

The real JAR is ignored by `.gitignore` by default. If Render is building only from GitHub, you have two simple choices:

### Choice A — easiest for a private repository
Remove `protected/*.jar` from `.gitignore`, commit `protected/Axiom-Client.jar`, and keep the GitHub repository PRIVATE.

### Choice B — stronger production setup
Keep the JAR out of GitHub and move downloads to private object storage. The website can then issue short-lived signed URLs after license validation.

## 2. Upload this folder to GitHub

Create a new GitHub repository and upload everything in this folder. Do NOT upload a `.env` file.

## 3. Deploy on Render

This project includes `render.yaml`, so you can use a Render Blueprint:

1. In Render, create a new Blueprint from the GitHub repository.
2. Render creates the Node web service and PostgreSQL database.
3. In the web service Environment settings, set:
   - `ADMIN_PASSWORD` — your private owner-panel password
   - `PUBLIC_DISCORD_URL` — your Discord invite URL
4. `JWT_SECRET` is generated automatically by the Blueprint.
5. Deploy.

If you create the service manually instead, use:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`

Then add a PostgreSQL database and set its connection string as `DATABASE_URL`.

## 4. Owner panel

Go to:

`https://YOUR-SITE.onrender.com/owner`

Sign in with `ADMIN_PASSWORD`. You can choose a duration in minutes, hours, days, weeks, or months, optionally type a client ID, and generate a key.

Keys look like:

`AXIOM-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`

The raw key is shown once. The database stores only its SHA-256 hash plus a short preview.

## 5. User activation/download

On the home page, a user enters:

- License key
- Client ID

If the key is active, it becomes bound to that client ID (if it was not already bound), the page displays `Key successful`, and a Windows download button unlocks for 10 minutes.

## 6. Make expiration actually disable the Minecraft client

This part is important: the website cannot magically shut off a JAR that is already on somebody's PC.

Your Minecraft mod must call:

`POST /api/license/check`

Body:

```json
{
  "key": "AXIOM-...",
  "clientId": "their-client-id"
}
```

Valid response:

```json
{
  "valid": true,
  "expiresAt": "2026-10-01T00:00:00.000Z"
}
```

Expired, revoked, invalid, or wrong-client-ID keys return a non-200 response with `valid: false`.

See `client-integration/AxiomLicenseClient.java` and `client-integration/README.md`.

## Security notes

- Keep `ADMIN_PASSWORD` and `JWT_SECRET` only in Render environment variables.
- Use a private GitHub repo if it contains your actual client JAR.
- Do not rely on website JavaScript for license security; all license decisions in this project happen server-side.
- A determined person can patch a client-side mod to bypass checks. Obfuscation can raise the effort, but no client-side DRM is unbreakable.
- Consider a terms/privacy page if you collect identifiers from users.

## Local development

You need Node.js 20+ and PostgreSQL.

1. Copy `.env.example` to `.env`.
2. Edit `DATABASE_URL`, `ADMIN_PASSWORD`, and `JWT_SECRET`.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000`.
