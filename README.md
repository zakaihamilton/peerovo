# Peerovo

Peerovo is shared WebRTC connectivity infrastructure for applications. It provides authenticated PeerJS signaling, ICE configuration, and short-lived coturn REST credentials around the core hierarchy:

```text
Project → Session → Peer
```

Peerovo handles connectivity and identity checks. Each application remains responsible for deciding whether a user may enter one of its sessions and which peer ID that user may claim.

## Run locally

Use Node.js 22.9 or newer. Copy `.env.example` to `.env`, replace every sample secret with a separate random secret of at least 32 bytes, and set the TURN host and secret for a reachable coturn server.

```sh
npm install
npm run dev
```

The local API and PeerJS signaling listener share port `9000`. Open `http://localhost:9000/v1/config` for the client connection settings.

## API and security contract

See [`docs/api-contract.md`](docs/api-contract.md) for the endpoint shapes, token claims, PeerJS handshake, TURN credential lifetime, rate limits, and the behavioral findings taken from HostPresent. See [`SECURITY.md`](SECURITY.md) for deployment and secret-handling requirements.

Projects can be provisioned in `PEEROVO_PROJECTS_JSON` or with a dedicated variable pair per project. Project API keys are server-only and authorize ticket issuance. The browser receives a peer ticket from its application backend, then uses that ticket for both PeerJS signaling and its ICE configuration request.

The in-memory signaling peer registry, admission leases, and rate limits require a single Peerovo replica. Put the service behind a TLS-enabled WebSocket proxy in production. Configure the proxy to redact `token` from PeerJS WebSocket access logs.

## Adding projects

For each additional application, see [docs/adding-projects.md](docs/adding-projects.md). It explains how to generate a project key and add independent project variables without replacing the existing project registry.

## Commands

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run health
npm run verify
```

`npm run health` runs the RepNix repository health check. `npm run verify` runs tests, lint, type checking, the production build, and RepNix.
