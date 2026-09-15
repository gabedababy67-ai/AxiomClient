# Axiom Client Website v4

Axiom Client website + account dashboard for Render/GitHub. This version makes Discord the account system, adds Stripe card checkout and Litecoin checkout, and keeps the resulting license key and HWID/client-ID binding on the customer's website account.

## What changed in v4

- Discord users with a role listed in `DISCORD_OWNER_ROLE_IDS` automatically get an **Owner Panel** tab in the normal dashboard.
- The owner panel is enforced server-side too; hiding/showing the button is not the security check.
- Owners can generate **Timed** keys for any whole number of days from 1 to 3650.
- Owners can generate **Lifetime** keys.
- Generated keys can optionally be pre-bound to a Discord user ID and/or Axiom client ID/HWID.
- Owners can view license status, revoke keys, and clear a device binding.
- The separate `/owner` page still works and now supports Timed/Lifetime keys too.
- A Discord role change is picked up the next time that user signs in with Discord.

## Existing v3 features

- The site is Discord-first: opening `/` shows the Discord sign-in gate until a valid session exists.
- Any member of the configured Discord server can sign in and purchase. They do **not** need the customer role before buying.
- Card payments use **Stripe Checkout**. Raw card numbers never pass through or get stored by this app.
- Litecoin payments use **NOWPayments** and `LTC` specifically.
- Successful purchases automatically create or extend an Axiom license tied to the signed-in Discord ID.
- Purchased keys are encrypted at rest so the full key can remain visible under **My License** on the account.
- The first client activation binds the key to its Axiom client ID/HWID value.
- Dashboard shows the license key, plan, expiration, status, HWID/client ID, and last-seen time.
- Existing owner-generated keys and key redemption still work.
- Optional Discord bot role grant automatically assigns the configured Customer role after a confirmed purchase.
- Device reset only clears Axiom's own stored device binding. It does not spoof or alter Windows hardware identifiers.

## Deploy on Render

Use:

```text
Language: Node
Build Command: npm install
Start Command: npm start
```

Put your client JAR at:

```text
protected/Axiom-Client.jar
```

Create a Render PostgreSQL database and use its Internal Database URL as `DATABASE_URL`.

## Discord values for this Axiom setup

These IDs are already known for your server:

```text
DISCORD_CLIENT_ID=1549504783944126494
DISCORD_GUILD_ID=1546629727542976614
DISCORD_ALLOWED_ROLE_IDS=1546629727979307139
DISCORD_CUSTOMER_ROLE_ID=1546629727979307139
DISCORD_OWNER_ROLE_IDS=1546629728004210731
DISCORD_REDIRECT_URI=https://axiomclient-1.onrender.com/auth/discord/callback
PUBLIC_SITE_URL=https://axiomclient-1.onrender.com
```

Keep `DISCORD_CLIENT_SECRET` private and use a newly regenerated value because any secret previously pasted into chat should be treated as exposed.

If you want the customer role to be granted automatically after payment, add `DISCORD_BOT_TOKEN` and give the bot **Manage Roles** permission. The bot's highest role must be above the Customer role in Discord's role list.

## Stripe card checkout

Create two Stripe Prices:

- Monthly: recurring monthly price, e.g. `$15.99`.
- Lifetime: one-time price, e.g. `$25.99`.

Set:

```text
STRIPE_SECRET_KEY=sk_...
STRIPE_MONTHLY_PRICE_ID=price_...
STRIPE_LIFETIME_PRICE_ID=price_...
```

Create a Stripe webhook endpoint pointing to:

```text
https://axiomclient-1.onrender.com/api/payments/stripe/webhook
```

Subscribe at minimum to:

```text
checkout.session.completed
invoice.paid
customer.subscription.deleted
```

Copy the webhook signing secret into:

```text
STRIPE_WEBHOOK_SECRET=whsec_...
```

The site redirects customers to Stripe's hosted Checkout page, so this app never receives or stores raw card details.

## Litecoin checkout

Create a NOWPayments account, configure your payout wallet, generate an API key, and generate an IPN secret. Add:

```text
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...
```

The app creates a payment with `pay_currency=ltc`, displays the exact LTC amount and address, polls payment status, and also accepts signed IPN callbacks at:

```text
https://axiomclient-1.onrender.com/api/payments/nowpayments/ipn
```

A Litecoin monthly purchase grants 30 days. A Litecoin lifetime purchase grants lifetime access.

## Required Render variables

See `.env.example` or `render.env.example`. Do not put secrets in a public GitHub repository.

## License / HWID flow

1. Customer signs in with Discord.
2. Customer buys Monthly or Lifetime with card or LTC, or redeems an owner-issued key.
3. Payment webhook confirms the payment server-side.
4. The site creates/extends the account's Axiom license.
5. **My License** displays the key.
6. Customer downloads Axiom from the account.
7. The Minecraft client calls `/api/license/activate` with the license key and its client-ID/HWID value.
8. The server binds that ID to the license.
9. Future `/api/license/check` calls fail if the license is expired, revoked, or presented from a different bound client ID.

See `client-integration/AxiomLicenseClient.java` for the included Java example.
