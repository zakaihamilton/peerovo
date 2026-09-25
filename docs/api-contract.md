# Peerovo API contract

This document defines Peerovo's first API contract and records the source inspections that shaped it. Phase 1 implementation and verification are complete. Phase 2 integrates HostPresent with this contract; ShiftingFront remains untouched.

## Findings from the current repositories

### HostPresent

The existing implementation is the behavioral reference:

- `signaling-server/server.mjs` uses PeerJS Server 1.0.2. The browser client uses PeerJS 1.5.5 and supplies the peer token in the signaling WebSocket upgrade.
- `src/app/api/rooms/config/route.js` returns the PeerJS host, path, port, public key, and `room-token-v1` auth mode.
- `src/app/api/rooms/state/route.js` first verifies the app's room token, then issues a separate short-lived ICE token and an authenticated peer ticket.
- `src/lib/room/peerAuthToken.mjs` signs tickets with HMAC-SHA256, checks signatures with a timing-safe comparison, caps tokens at 2,048 characters, enforces a dedicated audience and maximum seven-day lifetime, and binds the ticket to its exact PeerJS ID. HostPresent uses the stable host ID `hp-${roomId}` and a unique `pp-${jti}` participant ID.
- `signaling-server/server.mjs` rejects missing or duplicate WebSocket `id`, `token`, and `key` parameters, verifies the public PeerJS key, validates the exact peer ID, and avoids logging request URLs or ticket values.
- `src/app/api/media/ice-config/route.js` accepts the ICE token only in a header, returns no-store security headers, and issues coturn REST credentials for 120 seconds. It returns STUN plus UDP TURN and TCP/TLS TURN endpoints.
- `signaling-server/participantCapacity.mjs` caps a room at 29 participant connections. It reserves admission with 30-second leases, renews every 8 seconds, and releases on disconnect. The deployment docs require one signaling replica because PeerJS state and leases are process-local.
- `docs/vercel-security.md` sets edge limits for room creation, join-code resolution, token-state reads, and ICE-config reads, and requires redacting the WebSocket `token` query parameter in proxy logs.

Peerovo retains the reusable transport, credential, token, capacity, and abuse-control behaviors. It leaves HostPresent's room, role, join-code, and meeting decisions to HostPresent.

### Current application integration

HostPresent's `/api/rooms/state` route verifies its own room bearer before asking Peerovo for a peer ticket. HostPresent preserves the stable `hp-${roomId}` host ID and derives opaque participant IDs from its room token. It passes the room ID as Peerovo's session ID, and caps Peerovo ticket lifetime to the remaining room-token lifetime with a short safety margin. The browser receives the Peerovo peer ticket and requests ICE configuration from Peerovo with that ticket in an `Authorization` header.

HostPresent retains room membership, join-code, and meeting authorization. ShiftingFront currently has no multiplayer implementation; Peerovo integration can be added when multiplayer support is built there.

### ShiftingFront

The inspected `AGENTS.md`, `README.md`, `SECURITY.md`, and `docs/architecture.md` describe a client-side game with local persistence. A repository-wide source search found no PeerJS, WebRTC, ICE/TURN, WebSocket, or multiplayer implementation. ShiftingFront therefore has no current connectivity API contract to preserve and is not part of this integration phase.

## Resource and trust model

- A **Project** is configured by Peerovo at startup with a server-only API key and exact allowed browser origins.
- A **Session** is an opaque identifier chosen by the project backend. Peerovo treats it as a namespace and does not store game, meeting, or application session state.
- A **Peer** is a project-authorized peer ID within one session. A peer ticket cryptographically binds the project, session, and exact peer ID.

The project backend must authenticate its own user/session and decide which peer ID that user may use before requesting a ticket. The project API key never goes to a browser. This preserves application-specific checks such as HostPresent's host/participant ID rules without putting those concepts in Peerovo.

## Endpoints

### `GET /v1/config`

Public, non-secret PeerJS client settings. Cross-origin reads are allowed because the response only contains public endpoint information.

```json
{
  "signaling": "webrtc-peerjs",
  "signalingAuthMode": "project-session-peerovo-v1",
  "peerJs": {
    "host": "peerovo.example.com",
    "port": 443,
    "path": "/",
    "key": "peerjs",
    "secure": true,
    "debug": 0
  }
}
```

The browser passes the `peerToken` it receives from its own backend as PeerJS's `token` option and supplies the returned ICE servers to `RTCPeerConnection`.

### `POST /v1/projects/{projectId}/sessions/{sessionId}/peers`

Server-to-server peer ticket issuance. Requires `Authorization: Bearer <project-api-key>` and `Content-Type: application/json`. The project key must never be sent by a browser.

Request:

```json
{
  "peerId": "hp-3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "expiresInSeconds": 604800
}
```

`peerId` is required and must be 1–128 letters, numbers, dots, underscores, or hyphens. `expiresInSeconds` is optional and defaults to 604,800; the accepted range is 1–604,800 seconds. The application backend should set it no later than the expiry of its own user/session credential.
No other JSON properties are accepted.

Response (`201`):

```json
{
  "projectId": "hostpresent",
  "sessionId": "3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "peerId": "hp-3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "peerToken": "<signed-token>",
  "expiresAt": 1790337600
}
```

`expiresAt` is a Unix timestamp in seconds. Errors are JSON and return `400` for invalid inputs, `403` for invalid project credentials, `413` for oversized request bodies, `415` for a non-JSON content type, and `429` when rate limited.

### `GET /v1/projects/{projectId}/sessions/{sessionId}/peers/{peerId}/ice-config`

Requires `Authorization: Bearer <peerToken>`. The token's project, session, and peer claims must exactly match the URL. CORS is limited to that project's configured `allowedOrigins`.

Response (`200`):

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    {
      "urls": "turn:turn.example.com:443?transport=udp",
      "username": "1790337720:hostpresent:3f437493-66ef-4713-a9e5-1d89cc7cc125",
      "credential": "<coturn-rest-hmac>"
    },
    {
      "urls": "turns:turn.example.com:443?transport=tcp",
      "username": "1790337720:hostpresent:3f437493-66ef-4713-a9e5-1d89cc7cc125",
      "credential": "<coturn-rest-hmac>"
    }
  ],
  "expiresAt": 1790337720
}
```

The TURN username/credential pair is generated with coturn's REST HMAC-SHA1 scheme and expires after 120 seconds by default. `TURN_CREDENTIAL_TTL_SECONDS` may be set from 60 through 300 seconds. ICE responses are never cached.

### PeerJS signaling upgrade

The PeerJS signaling WebSocket uses the configured PeerJS base path and its standard `/peerjs` endpoint. The upgrade must contain exactly one each of `id`, `token`, and `key`. Peerovo verifies the public key, token signature, audience, expiry, project/session claims, and exact peer ID before reserving session capacity.

PeerJS carries the ticket in the WebSocket query string for protocol compatibility. Reverse proxies must redact `token` from access logs. HTTP API tokens are accepted only through `Authorization` headers, never query parameters.

### Health

- `GET /healthz` returns `200 {"status":"ok"}` while the process is running.
- `GET /readyz` returns `200 {"status":"ready"}` after required configuration has passed startup validation. Missing secrets or malformed project configuration prevent startup.

## Ticket claims and validation

Peer tickets use a base64url JSON payload and HMAC-SHA256 signature with `PEEROVO_SIGNING_SECRET`. Claims are:

```json
{
  "aud": "peerovo-peer-v1",
  "projectId": "hostpresent",
  "sessionId": "3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "peerId": "hp-3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "iat": 1790337000,
  "exp": 1790337600,
  "jti": "<32 lowercase hex characters>"
}
```

Verification rejects malformed or extra token segments, invalid signatures, wrong audience, invalid identifiers, future issue times beyond 60 seconds, expired tickets, lifetimes longer than seven days, and tokens over 2,048 characters. Signature comparison is timing-safe.

## Health and abuse controls

- HTTP responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a restrictive content security policy.
- The JSON request limit is 2 KiB. Ticket, ICE, and signaling upgrade requests have per-IP, per-process fixed-window limits; ticket and ICE defaults are 120/minute.
- `PEEROVO_MAX_PEERS_PER_SESSION` defaults to 30 peers total, matching HostPresent's 29 participants plus one host. Each signaling admission is reserved with a 30-second lease and renewed every 8 seconds; after two renewal errors or a lost lease, that peer is closed.
- PeerJS's global concurrent signaling limit defaults to 5,000. Signaling payloads are capped at 256 KiB and WebSocket compression is disabled.
- Local rate limits are process-local, so keep one replica and use the deployment firewall for edge-wide rate limits.

## Configuration

See `.env.example` for a complete local template. Required production values are:

- `PEEROVO_SIGNING_SECRET`
- `PEEROVO_PROJECTS_JSON` or at least one complete project-specific variable pair
- `TURN_DOMAIN`
- `TURN_SECRET_KEY`
- `PEEROVO_PUBLIC_HOST` and the browser-facing port/security settings

`PEEROVO_PROJECTS_JSON` is an object keyed by project ID. Each project has an `apiKey` (at least 32 characters) and an `allowedOrigins` array of exact HTTP origins, for example:

```json
{
  "hostpresent": {
    "apiKey": "<server-only-project-secret>",
    "allowedOrigins": ["https://hostpresent.example.com"]
  }
}
```
