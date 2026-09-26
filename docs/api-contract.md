# Peerovo API contract

This document describes Peerovo's implemented API contract and security behavior.

## Integration model

- Each application authenticates its users and decides which sessions and peer IDs they may use.
- The application backend uses its server-only project API key to request a Peerovo peer ticket after applying those authorization checks.
- Peerovo binds the ticket to one project, session, and exact peer ID. It does not make application membership or domain-state decisions.
- The browser uses the short-lived peer ticket for PeerJS signaling and requests ICE configuration from Peerovo with the ticket in an `Authorization` header.
- Peerovo manages signaling admission, capacity, rate limits, and TURN credential issuance. The application remains responsible for its own session behavior and any data exchanged by peers.

## Resource and trust model

- A **Project** is configured by Peerovo at startup with a server-only API key and exact allowed browser origins.
- A **Session** is an opaque identifier chosen by the project backend. Peerovo treats it as a namespace and does not store application state.
- A **Peer** is a project-authorized peer ID within one session. A peer ticket cryptographically binds the project, session, and exact peer ID.

The project backend must authenticate its own user/session and decide which peer ID that user may use before requesting a ticket. The project API key never goes to a browser. Application-specific membership, roles, and peer ID rules remain in the application.

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
  "peerId": "peer-3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "expiresInSeconds": 604800
}
```

`peerId` is required and must be 1–128 letters, numbers, dots, underscores, or hyphens. `expiresInSeconds` is optional and defaults to 604,800; the accepted range is 1–604,800 seconds. The application backend should set it no later than the expiry of its own user/session credential.
No other JSON properties are accepted.

Response (`201`):

```json
{
  "projectId": "sample-project",
  "sessionId": "session-3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "peerId": "peer-3f437493-66ef-4713-a9e5-1d89cc7cc125",
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
      "username": "1790337720:sample-project:session-3f437493-66ef-4713-a9e5-1d89cc7cc125",
      "credential": "<coturn-rest-hmac>"
    },
    {
      "urls": "turns:turn.example.com:443?transport=tcp",
      "username": "1790337720:sample-project:session-3f437493-66ef-4713-a9e5-1d89cc7cc125",
      "credential": "<coturn-rest-hmac>"
    }
  ],
  "expiresAt": 1790337720
}
```

The TURN username/credential pair is generated with coturn's REST HMAC-SHA1 scheme and expires after 120 seconds by default. `TURN_CREDENTIAL_TTL_SECONDS` may be set from 60 through 300 seconds. ICE responses are never cached.

### PeerJS signaling upgrade

The PeerJS signaling WebSocket uses the configured PeerJS base path and its standard `/peerjs` endpoint. The upgrade must contain exactly one each of `id`, `token`, and `key`. Peerovo verifies the public key, token signature, audience, expiry, project/session claims, and exact peer ID before reserving session capacity. Capacity is owned by the ticket's unique `jti`, so reconnecting with the same ticket can reclaim its existing peer slot while an old socket is still timing out.

On graceful service shutdown, Peerovo closes active signaling sockets with WebSocket close code `1012` (`Service Restart`) and gives them up to five seconds to close before terminating stragglers. PeerJS clients can then reconnect through their normal signaling reconnect flow.

PeerJS carries the ticket in the WebSocket query string for protocol compatibility. Reverse proxies must redact `token` from access logs. HTTP API tokens are accepted only through `Authorization` headers, never query parameters.

### Health

- `GET /healthz` returns `200 {"status":"ok"}` while the process is running.
- `GET /readyz` returns `200 {"status":"ready"}` after required configuration has passed startup validation. Missing secrets or malformed project configuration prevent startup.

## Ticket claims and validation

Peer tickets use a base64url JSON payload and HMAC-SHA256 signature with `PEEROVO_SIGNING_SECRET`. Claims are:

```json
{
  "aud": "peerovo-peer-v1",
  "projectId": "sample-project",
  "sessionId": "session-3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "peerId": "peer-3f437493-66ef-4713-a9e5-1d89cc7cc125",
  "iat": 1790337000,
  "exp": 1790337600,
  "jti": "<32 lowercase hex characters>"
}
```

Verification rejects malformed or extra token segments, invalid signatures, wrong audience, invalid identifiers, future issue times beyond 60 seconds, expired tickets, lifetimes longer than seven days, and tokens over 2,048 characters. Signature comparison is timing-safe.

## Health and abuse controls

- HTTP responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a restrictive content security policy.
- The JSON request limit is 2 KiB. Ticket, ICE, and signaling upgrade requests have per-IP, per-process fixed-window limits; ticket and ICE defaults are 120/minute.
- `PEEROVO_MAX_PEERS_PER_SESSION` defaults to 30 concurrent peers. Each signaling admission is reserved with a 30-second lease and renewed every 8 seconds; after two renewal errors or a lost lease, that peer is closed.
- Each project has its own concurrent-peer cap. `PEEROVO_MAX_PEERS_PER_PROJECT` defaults to 60; a project may override it with `maxPeers` in `PEEROVO_PROJECTS_JSON` or `PEEROVO_PROJECT_<SLUG>_MAX_PEERS`. The cap counts active admission leases across the project's sessions and does not combine separate projects.
- PeerJS's global concurrent signaling limit defaults to 5,000. Signaling payloads are capped at 256 KiB and WebSocket compression is disabled.
- Local rate limits are process-local, so keep one replica and use the deployment firewall for edge-wide rate limits.

### Usage summaries

Peerovo writes a JSON usage summary to stdout every five minutes by default (`PEEROVO_USAGE_LOG_INTERVAL_SECONDS`, configurable from 60 to 3,600 seconds) and once during shutdown. Per-project rolling counts include ticket requests/issuance, ICE-config requests/issuance, HTTP rate-limit rejections, signaling attempts/admissions/capacity rejections, current active peers, and the interval peak. Signaling-upgrade IP rate limits are counted service-wide because that limiter runs before Peerovo trusts a project's ticket. Counts reset after each summary; active and peak peer counts remain available for the next interval. No IPs, session IDs, peer IDs, tickets, or credentials are logged.

These summaries measure Peerovo API/signaling load, not TURN bandwidth. WebRTC media is relayed by coturn when needed, so traffic monitoring and any fair-use alert must be collected on the coturn host. See [TURN usage monitoring](turn-usage-monitoring.md).

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
  "sample-project": {
    "apiKey": "<server-only-project-secret>",
    "allowedOrigins": ["https://app.example.com"],
    "maxPeers": 60
  }
}
```
