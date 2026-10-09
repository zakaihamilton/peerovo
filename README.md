<div align="center">
  <img src="assets/peerovo-logo.png" alt="Peerovo" width="520" />

  <h1>WebRTC connectivity for every app you build</h1>

  <p>One shared service for PeerJS signaling, session-bound peer tickets, and short-lived ICE credentials.</p>

  <p><a href="docs/adding-projects.md">Connect an application →</a> · <a href="https://peerovo.up.railway.app/v1/config">View the hosted service config</a></p>
</div>

Peerovo gives application backends a consistent way to connect users they've authorized across WebRTC sessions. Your backend authenticates users and decides who may join; Peerovo issues signed peer tickets, admits signaling connections, and returns ICE configuration.

## Why Peerovo

- **Connect multiple applications through one service.** Keep each app's projects, sessions, and peers namespaced and independently configured.
- **Keep access decisions in your app.** Your backend requests signed, time-limited tickets bound to a project, session, and exact peer ID. Project keys stay on your server; browsers receive only the peer ticket.
- **Give browsers the ICE settings they need.** Peerovo returns public STUN settings and short-lived coturn REST credentials for TURN relay when a direct connection is unavailable.
- **See service activity by project.** Secret-free usage summaries report ticket, ICE, signaling, capacity, and admission counts. TURN media bandwidth is measured on the coturn host.

## How it works

```text
Your app backend ── project key ──▶ Peerovo
       │                            │
       └── peer ticket ──▶ Browser ◀── ICE config + PeerJS signaling
```

1. Your backend authenticates the user and authorizes access to the session.
2. It requests a peer ticket from Peerovo with the authorized session and peer ID.
3. The browser uses that ticket for PeerJS signaling and to request ICE settings. Coturn relays media when WebRTC selects a TURN route.

Your application remains responsible for user authentication, room membership, and which peer IDs users may claim. Peerovo checks that each ticket matches the project, session, and peer attempting to connect.

## Connect an application

The hosted service's production API origin is `https://peerovo.up.railway.app` ([public client config](https://peerovo.up.railway.app/v1/config)). Follow the [application onboarding guide](docs/adding-projects.md) to register a project, set its allowed browser origins, and connect your backend and browser. It includes the ticket request flow, deployment variables, and staging verification steps.

## Run locally or self-host

Use Node.js 22.9 or newer. Copy `.env.example` to `.env`, replace each sample secret with a separate random secret of at least 32 bytes, and configure a reachable coturn server.

```sh
npm install
npm run dev
```

The local API and PeerJS signaling listener share port `9000`. Open [`http://localhost:9000/v1/config`](http://localhost:9000/v1/config) for the client connection settings.

For production, run one Peerovo replica because the signaling registry, admission leases, and rate limits are held in process memory. Put the service behind a TLS-enabled WebSocket proxy and redact the PeerJS `token` query parameter from proxy logs.

## Documentation

- [Application onboarding](docs/adding-projects.md) — project setup and integration flow
- [API and security contract](docs/api-contract.md) — endpoints, ticket claims, limits, and troubleshooting
- [Deployment security](SECURITY.md) — secrets, proxy, and production requirements
- [TURN usage monitoring](docs/turn-usage-monitoring.md) — coturn relay bandwidth and limits

## Testing applications

Peerovo includes an application-agnostic Playwright helper under `packages/test` for tests that need multiple independent browser clients. See [the multi-client testing guide](docs/testing.md) for host/player examples and the separate deployed TURN smoke-test strategy.

## Development

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run health
npm run verify
```

`npm run health` runs the repository health check. `npm run verify` runs tests, lint, type checking, the production build, and the health check.
