import { createServer, type Server } from "node:http";
import { ExpressPeerServer, type IClient, type PeerServerEvents } from "peer";
import { type WebSocket, WebSocketServer } from "ws";
import {
  isPeerAuthorizedForClaims,
  type PeerClaims,
  verifyPeerToken,
} from "./auth/peerToken.js";
import { loadConfig, type PeerovoConfig } from "./config/config.js";
import { createApiApp } from "./http/app.js";
import {
  createPeerCapacityStore,
  PEER_CAPACITY_RENEW_INTERVAL_MS,
} from "./peers/capacity.js";
import {
  type Admission,
  createUpgradeAuthorizer,
  type PeerovoIncomingMessage,
} from "./peers/upgradeAuth.js";
import { FixedWindowRateLimiter } from "./security/rateLimiter.js";

interface PeerovoWebSocket extends WebSocket {
  peerovoAdmission?: Admission;
}

interface ActivePeer {
  client: IClient;
  claims: PeerClaims;
  ownerId: string;
  renewalFailures: number;
}

interface ActiveSession {
  projectId: string;
  sessionId: string;
  peers: Map<string, ActivePeer>;
}

function activeSessionKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

export interface PeerovoRuntime {
  app: ReturnType<typeof createApiApp>;
  server: Server;
  peerServer: PeerServerEvents;
  close(): Promise<void>;
}

export function createPeerovoRuntime(config: PeerovoConfig): PeerovoRuntime {
  const app = createApiApp(config);
  const server = createServer(app);
  const capacity = createPeerCapacityStore({
    maxPeersPerSession: config.maxPeersPerSession,
  });
  const activePeersBySession = new Map<string, ActiveSession>();
  const signalingRateLimiter = new FixedWindowRateLimiter(config.signalingRateLimit);
  const authorizeUpgrade = createUpgradeAuthorizer({
    config,
    capacity,
    limiter: signalingRateLimiter,
  });

  const peerServer = ExpressPeerServer(server, {
    key: config.key,
    path: config.path,
    proxied: config.proxied,
    allow_discovery: false,
    concurrent_limit: config.maxSignalingConnections,
    createWebSocketServer: (options) => {
      const webSocketServer = new WebSocketServer({
        ...options,
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
        verifyClient: (info, callback) =>
          authorizeUpgrade({ req: info.req as PeerovoIncomingMessage }, callback),
      });
      webSocketServer.on("connection", (socket, request) => {
        const admission = (request as PeerovoIncomingMessage).peerovoAdmission;
        if (admission) {
          (socket as PeerovoWebSocket).peerovoAdmission = admission;
        }
      });
      return webSocketServer;
    },
  });

  // The application API owns /v1. PeerServer mounts at its configured base path
  // after it, leaving PeerJS's own HTTP and WebSocket routes available.
  app.use(peerServer);

  peerServer.on("connection", (client) => {
    const claims = verifyPeerToken(client.getToken(), config.signingSecret);
    const socket = client.getSocket() as PeerovoWebSocket | null;
    const admission = socket?.peerovoAdmission;
    if (
      !claims ||
      !admission ||
      admission.claims.projectId !== claims.projectId ||
      admission.claims.sessionId !== claims.sessionId ||
      admission.claims.peerId !== claims.peerId ||
      !isPeerAuthorizedForClaims(
        client.getId(),
        claims.projectId,
        claims.sessionId,
        claims,
      )
    ) {
      socket?.close(1011, "Peer admission is invalid");
      return;
    }

    const key = activeSessionKey(claims.projectId, claims.sessionId);
    let activeSession = activePeersBySession.get(key);
    if (!activeSession) {
      activeSession = {
        projectId: claims.projectId,
        sessionId: claims.sessionId,
        peers: new Map(),
      };
      activePeersBySession.set(key, activeSession);
    }

    const previous = activeSession.peers.get(client.getId());
    const entry: ActivePeer = {
      client,
      claims,
      ownerId: admission.ownerId,
      renewalFailures: 0,
    };
    activeSession.peers.set(client.getId(), entry);
    if (previous) {
      void capacity
        .release(
          previous.claims.projectId,
          previous.claims.sessionId,
          client.getId(),
          previous.ownerId,
        )
        .catch(() => {});
    }
  });

  peerServer.on("disconnect", (client) => {
    const claims = verifyPeerToken(client.getToken(), config.signingSecret);
    if (!claims) return;
    const key = activeSessionKey(claims.projectId, claims.sessionId);
    const activeSession = activePeersBySession.get(key);
    const entry = activeSession?.peers.get(client.getId());
    if (!activeSession || !entry || entry.client !== client) {
      return;
    }

    activeSession.peers.delete(client.getId());
    if (activeSession.peers.size === 0) activePeersBySession.delete(key);
    void capacity
      .release(claims.projectId, claims.sessionId, client.getId(), entry.ownerId)
      .catch(() => {});
  });

  peerServer.on("error", () => {
    // PeerJS errors can be triggered by untrusted signaling traffic. Avoid
    // logging request URLs, ticket values, or library error details.
    process.stderr.write("[peerovo] signaling server error\n");
  });

  let renewalInFlight = false;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight) return;
    renewalInFlight = true;
    void (async () => {
      try {
        await Promise.all(
          [...activePeersBySession.values()].map(async (activeSession) => {
            const owners = [...activeSession.peers].map(([peerId, entry]) => ({
              peerId,
              ownerId: entry.ownerId,
            }));
            let renewedOwnerIds: Set<string>;
            try {
              renewedOwnerIds = new Set(
                await capacity.renew(
                  activeSession.projectId,
                  activeSession.sessionId,
                  owners,
                ),
              );
            } catch {
              for (const [peerId, entry] of activeSession.peers) {
                if (activeSession.peers.get(peerId) !== entry) continue;
                entry.renewalFailures += 1;
                if (entry.renewalFailures >= 2) {
                  entry.client
                    .getSocket()
                    ?.close(1013, "Session admission unavailable");
                }
              }
              return;
            }

            for (const [peerId, entry] of activeSession.peers) {
              if (activeSession.peers.get(peerId) !== entry) continue;
              if (!renewedOwnerIds.has(entry.ownerId)) {
                entry.client
                  .getSocket()
                  ?.close(1013, "Session admission lease expired");
                continue;
              }
              entry.renewalFailures = 0;
            }
          }),
        );
      } finally {
        renewalInFlight = false;
      }
    })();
  }, PEER_CAPACITY_RENEW_INTERVAL_MS);
  renewalTimer.unref?.();

  return {
    app,
    server,
    peerServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(renewalTimer);
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

export async function startPeerovo(config = loadConfig()): Promise<PeerovoRuntime> {
  const runtime = createPeerovoRuntime(config);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      runtime.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      runtime.server.off("error", onError);
      resolve();
    };
    runtime.server.once("error", onError);
    runtime.server.once("listening", onListening);
    runtime.server.listen(config.port, config.host);
  });
  return runtime;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await startPeerovo(config);
  const address = runtime.server.address();
  const endpoint =
    typeof address === "string"
      ? address
      : address
        ? `${address.address}:${address.port}`
        : "unknown";
  process.stdout.write(
    `[peerovo] authenticated PeerJS service listening on ${endpoint}${config.path}\n`,
  );

  const shutdown = () => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch(() => {
    process.stderr.write("[peerovo] startup failed; check required configuration\n");
    process.exitCode = 1;
  });
}
