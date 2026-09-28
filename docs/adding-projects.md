# Onboard an application to Peerovo

Use this runbook whenever you connect another application to Peerovo. Peerovo creates short-lived peer tickets and ICE credentials; the application remains responsible for user authentication, room membership, and deciding which peer IDs its users may claim.

## Ownership and request flow

```text
Application backend -- project API key --> Peerovo ticket endpoint
Browser             -- peer ticket -----> Peerovo ICE endpoint and PeerJS signaling
```

The project API key is a server-side credential. Never put it in browser code, a `NEXT_PUBLIC_*` variable, a client bundle, a URL, or a log. The browser receives only the short-lived peer ticket from the application's backend. See [the API contract](api-contract.md) and [security requirements](../SECURITY.md) for the full protocol.

## 1. Choose the project ID and browser origins

- Choose a stable lowercase kebab-case ID, such as `shiftingfront` or `my-new-app`. The ID is used in API paths and environment-variable names; treat it as permanent once deployed.
- List every exact browser origin that will request ICE configuration: production, any stable preview domain, and local development if needed. An origin includes scheme and host, but no path or trailing slash. For example, use `https://app.example.com`, not `https://app.example.com/game/`.
- Do not use wildcard origins. Add temporary preview origins only when needed, then remove them when those previews are retired.
- Decide whether the project needs a custom concurrent-peer cap. The default is 60; the supported override is 1–500.

## 2. Generate the Peerovo project settings

Run this from the Peerovo repository. Repeat `--origin` for every exact origin. Include `--max-peers` only when you want to override the default.

```sh
npm run project:add -- --id my-new-app \
  --origin https://app.example.com \
  --origin http://localhost:3000 \
  --max-peers 40
```

The command generates a unique 32-byte project API key and prints the Peerovo variables. For this example, they look like:

```dotenv
PEEROVO_PROJECT_MY_NEW_APP_API_KEY=<generated-secret>
PEEROVO_PROJECT_MY_NEW_APP_ALLOWED_ORIGINS=["https://app.example.com","http://localhost:3000"]
PEEROVO_PROJECT_MY_NEW_APP_MAX_PEERS=40
```

The API key is shown only by the command. Copy it directly into the secret stores in the next steps; do not commit it or save the command output in a ticket, chat, or source file. `MAX_PEERS` is optional. If omitted, Peerovo uses its configured per-project default.

## 3. Register the project on the Peerovo service

1. In the Peerovo service's Railway Variables page, add the generated API key, origins JSON, and optional peer cap.
2. Configure each project with its own complete API-key and allowed-origins variable pair. Peerovo rejects incomplete pairs and duplicate project IDs.
3. Apply the variables and wait for Railway to restart the service. Check startup/health logs for configuration errors without copying secret values into logs or chat.
4. Keep Peerovo at one replica. Its signaling registry, admission leases, and rate-limit counters are process-local.

The allowed-origins variable is not secret, but it is security-sensitive configuration: include only origins controlled by the application. The API key is secret and must remain private.

## 4. Configure the application backend

In the new application's server-side environment, set:

```dotenv
PEEROVO_API_URL=https://<peerovo-public-host>
PEEROVO_PROJECT_ID=my-new-app
PEEROVO_PROJECT_API_KEY=<same-generated-secret>
```

Use the Peerovo public HTTPS origin only—no `/v1` suffix, path, query, or trailing route. In production, use HTTPS. Add the API key to each deployment environment that needs it (for example, Vercel Production and Preview), and redeploy or restart the application after changing environment variables. Keep the variable server-side; do not prefix it with `NEXT_PUBLIC_`.

For local development, put these values in an ignored `.env` file. Keep placeholders only in `.env.example`. Give each application a different project key. Peerovo's global signing and TURN secrets remain on the Peerovo service; a new application does not need its own copy of them.

An application may also need its own session or room-signing secret. That is separate from the Peerovo project API key and should be configured only in that application's backend.

## 5. Implement the backend-to-Peerovo flow

The application's backend should:

1. Authenticate the user and authorize their access to the application's session before contacting Peerovo.
2. Request a ticket from `POST /v1/projects/{projectId}/sessions/{sessionId}/peers`, using `Authorization: Bearer <project-api-key>` and a JSON body containing the authorized `peerId`. Set `expiresInSeconds` no later than the user's session expiry. Peerovo returns `201` with a ticket bound to the project, session, and exact peer ID.
3. Return only the peer ticket and the minimum client settings needed by the browser. Never return the project API key.
4. Let the browser request `GET /v1/projects/{projectId}/sessions/{sessionId}/peers/{peerId}/ice-config` with the peer ticket as a Bearer token, and use the ticket for PeerJS signaling.

`GET /v1/config` provides public PeerJS connection settings. Confirm its `signalingAuthMode` is `project-session-peerovo-v1` before relying on project tickets. See [the API contract](api-contract.md) for response formats and validation rules.

PeerJS carries its ticket in the WebSocket query string for protocol compatibility. Configure the reverse proxy and observability tools to redact the `token` query parameter. HTTP ticket and ICE credentials belong in authorization headers, never query parameters.

## 6. Configure the application's edge limits

Peerovo applies its own per-process API and signaling limits. Add a shared edge rate limiter for the application's public room/session endpoints as a separate layer, especially when those endpoints can mint Peerovo tickets.

For an application using Vercel's `@vercel/firewall` SDK:

- Create one Firewall rule for each rate-limit ID the code calls.
- Make the first condition `@vercel/firewall` and enter the exact ID from the code. Keep the intended fixed-window threshold and `429` action.
- Do not add ordinary Request Path or Method conditions for the application's API route to this rule. The SDK checks a special `/.well-known/vercel/rate-limit-api/{id}` endpoint; those route filters can block the SDK check and make the ID appear unconfigured. Keep the SDK rule limited to its `@vercel/firewall` ID unless additional conditions have been tested against the SDK's forwarded request headers.
- Publish the rules to every environment where the code calls the SDK. A missing ID makes a fail-closed application return `503`.

If the application runs outside Vercel, configure an equivalent shared edge limiter for its ticket-minting and room/session routes. Follow that application's deployment guide for any provider-specific flag; do not substitute an instance-local counter in a serverless deployment.

## 7. Verify the integration

Run these checks in a preview or staging environment first:

- Peerovo starts with the new project ID and the allowed-origin list. Existing projects remain configured with their own dedicated variable pairs.
- `GET {PEEROVO_API_URL}/v1/config` returns valid PeerJS settings and `project-session-peerovo-v1` signaling auth mode.
- An authorized backend request creates a peer ticket (`201`); the ticket's project, session, peer ID, and expiry match the application session.
- The browser can fetch ICE settings and establish PeerJS signaling with the ticket. ICE requests from an allowed origin receive CORS headers; an unlisted origin does not.
- Two clients can join the same application session and exchange the intended application messages. A client that is not authorized by the application cannot get a peer ticket.
- Peerovo's periodic usage summary shows activity under the new project ID and no unexpected admission failures.

Exercise rate-limit boundaries with invalid, non-mutating payloads in a non-production environment. Do not burst production routes just to test the limiter; those requests consume service and edge usage.

## ShiftingFront reference

ShiftingFront uses project ID `shiftingfront` and production origin `https://www.shiftingfront.com`. Its Vercel backend uses `PEEROVO_API_URL`, `PEEROVO_PROJECT_ID`, and `PEEROVO_PROJECT_API_KEY`; secrets stay in server-side Vercel environment variables. Its Vercel WAF limits are fixed-window limits per IP:

| Rate-limit ID | Endpoint | Limit |
| --- | --- | ---: |
| `shiftingfront-multiplayer-room-create` | `POST /api/multiplayer/rooms` | 10 per 10 minutes |
| `shiftingfront-multiplayer-room-join` | `POST /api/multiplayer/rooms/join` | 20 per minute |
| `shiftingfront-multiplayer-handshake` | `POST /api/multiplayer/handshake` | 60 per minute |
| `shiftingfront-multiplayer-peer-credentials` | `POST /api/multiplayer/peer-credentials` | 120 per minute |

These IDs and limits live in ShiftingFront's code and its Vercel Firewall configuration. Reuse the pattern for another application, but choose unique IDs and limits that match that application's endpoints and traffic.

## Troubleshooting

- **Peerovo rejects the project key:** verify the project ID, API key, and slug-derived Railway variable names match. Confirm the service restarted after the variables were applied.
- **ICE fails only in the browser:** check the browser's exact `Origin` against the project's allowed-origins JSON. Include the scheme and hostname; no path or trailing slash.
- **Application reports Peerovo unavailable:** check `PEEROVO_API_URL` is the HTTPS origin without `/v1`, and inspect service health without logging credentials.
- **Vercel returns `503` for a rate-limit check:** confirm each code ID exists in a published `@vercel/firewall` rule. Remove Request Path/Method filters from SDK rules, then retest with a normal request.
- **Signaling is admitted but peers cannot exchange media:** inspect browser ICE candidate state and coturn reachability/credentials. Peerovo's logs do not include relayed media traffic; monitor coturn separately.
