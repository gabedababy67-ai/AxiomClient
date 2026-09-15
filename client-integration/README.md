# Axiom client-side license hookup

Your website handles key generation, activation, expiration, revocation, and client-ID binding. To actually stop the Minecraft mod after a key expires, the mod must check the API.

## Recommended flow

1. On first launch, ask the user for their license key.
2. Generate or retrieve a stable client ID for that installation/account.
3. Call `POST https://YOUR-DOMAIN/api/license/activate` with JSON:
   `{ "key": "AXIOM-...", "clientId": "..." }`
4. Store the key locally in your config only if activation succeeds.
5. On every game launch, call `POST /api/license/check`.
6. While Minecraft remains open, check again periodically (for example every few minutes, not every tick).
7. If the API returns a non-200 result or `{ "valid": false }`, disable the licensed client features and show an expired/revoked message.

The included `AxiomLicenseClient.java` is a deliberately small integration example. Replace the string-based JSON check with your mod's normal JSON library.

## Client ID note

Do not use invasive hardware fingerprinting. A randomly generated UUID saved to your mod config is usually enough for installation binding. If you need account binding instead, use an identifier appropriate to your own client design and privacy policy.
