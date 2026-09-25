# Security

Peerovo handles project API keys, signed peer tickets, WebSocket signaling admission, and coturn REST credentials. It does not authenticate people or decide application membership. The application backend must verify its own session or membership credential before asking Peerovo to issue a peer ticket.

## Deployment requirements

- Keep `PEEROVO_SIGNING_SECRET`, every project `apiKey`, and `TURN_SECRET_KEY` server-side. Use separate random secrets with at least 32 bytes of entropy.
- Keep Peerovo to one replica. Its PeerJS peer registry, room capacity leases, and rate-limit counters are process-local.
- Expose PeerJS over TLS and WebSocket through a trusted reverse proxy. Set `PEEROVO_PUBLIC_HOST`, `PEEROVO_PUBLIC_PORT`, and `PEEROVO_PUBLIC_SECURE` to the browser-facing values.
- Set `PEEROVO_TRUST_PROXY=true` only when the proxy overwrites `X-Forwarded-For`. Otherwise Peerovo ignores forwarded IP headers for rate limiting.
- Configure each project's exact browser origins in `PEEROVO_PROJECTS_JSON` or its dedicated `PEEROVO_PROJECT_<SLUG>_ALLOWED_ORIGINS` variable. The ICE endpoint returns CORS headers only for those origins.
- Redact the PeerJS WebSocket `token` query parameter from proxy access logs. PeerJS carries it in the upgrade URL because that is the protocol used by its client.
- Put shared or public HTTP routes behind the platform firewall or edge rate limiter as an additional layer. Peerovo also applies per-process request limits.

Peer tickets are HMAC-SHA256 signed, use a dedicated audience, bind project, session, and peer IDs, and expire within seven days. TURN usernames carry an expiry timestamp and are signed with coturn's REST HMAC-SHA1 scheme; the default lifetime is 120 seconds and configuration cannot exceed 300 seconds. Responses carrying credentials use `Cache-Control: no-store`.

PeerJS upgrades reject missing or duplicated `id`, `token`, or `key` parameters, mismatched public keys, invalid or expired tickets, and peer IDs that do not match the signed ticket. The service caps signaling payloads and active peers per session. Admission uses short leases so abandoned or failed upgrades do not permanently consume capacity.
