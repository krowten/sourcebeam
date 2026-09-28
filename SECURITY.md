# Security policy

sourcebeam is self-hosted. Every deployment is its own instance on its owner's Cloudflare
account, so there is no central service to coordinate with, but a bug in this code affects
everyone who deploys it.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub
([Security → Report a vulnerability](https://github.com/krowten/sourcebeam/security/advisories/new))
rather than in a public issue. Include what you found, how to reproduce it, and what an
attacker could do with it.

## Scope worth knowing about

The security-relevant surfaces are small and deliberate:

- **Host tokens** (KV keys) gate all write access. Rotating one is a KV delete and a put;
  the Worker itself stays untouched.
- **Invite tokens** are HMAC-signed and expiring. `rotate_view_secret`, like deleting the
  project, invalidates everything issued so far.
- The viewer is read-only by construction. Nothing a viewer does can execute code.
- What leaves the host's machine is decided by the project's `.gitignore`: every text file it
  doesn't exclude is broadcast, `.env` files and keys included, so list secrets there. Only
  `.git/` is never sent, whatever `.gitignore` says.

If any of those properties fails to hold, that is exactly the kind of report we want.
