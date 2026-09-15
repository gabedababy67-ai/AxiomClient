# Axiom Client Website v2

This is a ready-to-deploy Node/Express + PostgreSQL website for Axiom Client. It uses the supplied purple `AC` logo and an original dark/slate client-site design inspired by the screenshots you provided.

## Included

- Axiom Client home page with Home, Modules, Pricing, Reviews, Discord, and Dashboard navigation.
- Clickable module cards.
- Pricing buttons with configurable destinations.
- Public reviews pulled from PostgreSQL.
- Discord OAuth login.
- Discord server role gate for the user dashboard.
- Separate Discord owner-role support plus the existing owner-password login.
- Dashboard pages: Downloads, Updates, Redeem Key, Reviews, BaseFinds, Suggestions, Utilities, FAQ.
- Timed license keys.
- Client-ID binding.
- License-to-Discord-account binding.
- Protected Windows JAR download.
- Owner key generation, revoke, and unbind controls.
- Axiom license-device/HWID reset (2 resets per rolling 30 days).
- Default config download.
- Basic crash-log analyzer.
- Java example for checking key expiration from the Minecraft client.

The HWID utility only resets the **Axiom license binding stored in this website database**. It does not spoof Windows hardware IDs or bypass third-party bans/anti-cheat systems.

## 1. Put your client JAR in the project

Place the real JAR here:

```text
protected/Axiom-Client.jar
```

`protected/*.jar` is ignored by Git by default. If you intentionally want the JAR in a **private** GitHub repository, remove that ignore rule first.

## 2. Render basics

Use:

```text
Language: Node
Build Command: npm install
Start Command: npm start
```

Create a PostgreSQL database on Render in the same region as the web service. Add its **Internal Database URL** to the web service as `DATABASE_URL`.

## 3. Required Render environment variables

```text
NODE_ENV=production
DATABASE_SSL=false
ADMIN_PASSWORD=YOUR_PRIVATE_OWNER_PASSWORD
JWT_SECRET=YOUR_LONG_RANDOM_SECRET_AT_LEAST_32_CHARS
PUBLIC_DISCORD_URL=https://discord.gg/YOURINVITE
PUBLIC_CLIENT_VERSION=1.0.0
PUBLIC_CLIENT_UPDATED=Sep 15, 2026
DOWNLOAD_FILENAME=Axiom-Client.jar
```

Optional purchase/store destinations:

```text
PUBLIC_MONTHLY_URL=/dashboard?tab=redeem
PUBLIC_LIFETIME_URL=/dashboard?tab=redeem
PUBLIC_DEVICE_SLOT_URL=/dashboard?tab=utilities
```

## 4. Discord OAuth + role setup

Create or open an application in the Discord Developer Portal.

Under OAuth2, add this redirect URL exactly:

```text
https://YOUR-RENDER-NAME.onrender.com/auth/discord/callback
```

Then add these Render variables:

```text
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_CLIENT_SECRET=your_application_client_secret
DISCORD_GUILD_ID=your_discord_server_id
DISCORD_ALLOWED_ROLE_IDS=role_id_1,role_id_2
DISCORD_OWNER_ROLE_IDS=owner_role_id_1,owner_role_id_2
DISCORD_REDIRECT_URI=https://YOUR-RENDER-NAME.onrender.com/auth/discord/callback
```

`DISCORD_ALLOWED_ROLE_IDS` controls who can enter `/dashboard`.

`DISCORD_OWNER_ROLE_IDS` lets those roles enter the owner API/panel after Discord login. The password login at `/owner` also continues to work.

To copy a Discord server/role ID, enable Discord Developer Mode, then right-click the server or role and choose **Copy ID**.

## 5. Dashboard flow

1. User opens `/dashboard`.
2. User clicks **Continue with Discord**.
3. The site verifies that the user is in your configured server and has an allowed role.
4. User opens **Redeem Key**.
5. User enters an Axiom key and client ID.
6. The key becomes linked to that Discord user and client ID.
7. The Downloads page creates a short-lived download ticket and serves `protected/Axiom-Client.jar`.

## 6. Owner key generator

Open:

```text
https://YOUR-SITE/owner
```

You can generate a key for minutes, hours, days, weeks, or months. You can optionally pre-bind the key to a client ID or Discord user ID.

The raw key is shown once. PostgreSQL stores only its SHA-256 hash and a short preview.

## 7. Minecraft client license check

The client should periodically call:

```http
POST /api/license/check
Content-Type: application/json
```

```json
{
  "key": "AXIOM-...",
  "clientId": "the-client-id"
}
```

An expired/revoked/mismatched license returns `valid: false`.

See `client-integration/AxiomLicenseClient.java` for the included example.

## Important secret handling

Never put these in public GitHub source:

- `ADMIN_PASSWORD`
- `JWT_SECRET`
- `DATABASE_URL`
- `DISCORD_CLIENT_SECRET`

Keep them in Render Environment Variables.
