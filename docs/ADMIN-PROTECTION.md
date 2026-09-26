# Admin protection plan (Cloudflare Access later)

CoffeeJack-native accounts are the public login path. **Do not disable Cloudflare Access until this plan is applied by the operator.**

## Target

```text
https://coffeejack-agent.com
  → CoffeeJack email/password (Standard accounts)
  → isolated workspace

https://admin.coffeejack-agent.com
  or https://coffeejack-agent.com/admin
  → Cloudflare Access (Owner-only allowlist)
  → existing Owner session / data
```

## This release

- Cloudflare Access JWT verification stays on the remote path.
- Public registration always creates `role=standard`.
- Owner credentials can be attached to the existing Abdulrahman account (no second Owner).

## Later cutover (not automatic)

1. Confirm Owner email/password login works and data is intact.
2. Create a second Access application limited to the Owner email.
3. Point that application at `/admin` or `admin.coffeejack-agent.com`.
4. Remove Access from the public hostname only after Standard signup/login is verified live.
5. Require CoffeeJack email/password on loopback (`127.0.0.1` / `localhost`); do not auto-sign in the Owner.
