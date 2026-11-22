import { createServer, type Server } from "node:http";
import { ExpressPeerServer, type PeerServerEvents } from "peer";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, type PeerovoConfig } from "./config/config.js";
import { createApiApp } from "./http/app.js";
import { createPeerCapacityStore } from "./peers/capacity.js";
import {
  createPeerovoConnectionDiagnostics,
  type PeerovoConnectionDiagnostics,
} from "./peers/diagnostics.js";
import {
  createPeerSessionRegistry,
  type PeerovoWebSocket,
  safeErrorType,
} from "./peers/sessionRegistry.js";
import {
  createUpgradeAuthorizer,
  type PeerovoIncomingMessage,
} from "./peers/upgradeAuth.js";
import { FixedWindowRateLimiter } from "./security/rateLimiter.js";
import { createPeerovoUsageTracker } from "./usage/metrics.js";

const SERVICE_RESTART_CLOSE_CODE = 1012;
const SOCKET_DRAIN_TIMEOUT_MS = 5_000;

function safeErrorCode(error: Error): string | null {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : null;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown startup error";
  return error.message.replace(/[\r\n\t]+/g, " ").slice(0, 240) || safeErrorType(error);
}

function writeUsageSummary(
  usage: ReturnType<typeof createPeerovoUsageTracker>,
  diagnostics: PeerovoConnectionDiagnostics,
): void {
  process.stdout.write(
    `[peerovo] usage ${JSON.stringify({
      ...usage.flush(),
      connectionDiagnostics: diagnostics.flush(),
    })}\n`,
  );
}

function waitForSocketDrain(sockets: WebSocket[], timeoutMs: number): Promise<void> {
  const pending = sockets.filter((socket) => socket.readyState !== WebSocket.CLOSED);
  if (pending.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let remaining = pending.length;
    const timeout = setTimeout(resolve, timeoutMs);
    for (const socket of pending) {
      socket.once("close", () => {
        remaining -= 1;
        if (remaining === 0) {
          clearTimeout(timeout);
          resolve();
        }
      });
    }
  });
}

export interface PeerovoRuntime {
  app: ReturnType<typeof createApiApp>;
  server: Server;
  peerServer: PeerServerEvents;
  close(): Promise<void>;
}

export function createPeerovoRuntime(config: PeerovoConfig): PeerovoRuntime {
  const usage = createPeerovoUsageTracker(config.projects.keys());
  const connectionDiagnostics = createPeerovoConnectionDiagnostics();
  const app = createApiApp(config, undefined, usage);
  const server = createServer(app);
  server.on("error", (error) => {
    const code = safeErrorCode(error);
    process.stderr.write(
      `[peerovo] HTTP server error type=${safeErrorType(error)}${code ? ` code=${code}` : ""}\n`,
    );
  });
  const capacity = createPeerCapacityStore({
    maxPeersPerSession: config.maxPeersPerSession,
    maxPeersPerProject: (projectId) =>
      config.projects.get(projectId)?.maxPeers ?? config.maxPeersPerProject,
  });
  const signalingRateLimiter = new FixedWindowRateLimiter(config.signalingRateLimit);
  const authorizeUpgrade = createUpgradeAuthorizer({
    config,
    capacity,
    limiter: signalingRateLimiter,
    usage,
    diagnostics: connectionDiagnostics,
  });
  let peerWebSocketServer: WebSocketServer | null = null;

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
      peerWebSocketServer = webSocketServer;
      return webSocketServer;
    },
  });

  // The application API owns /v1. PeerServer mounts at its configured base path
  // after it, leaving PeerJS's own HTTP and WebSocket routes available.
  app.use(peerServer);

  const sessionRegistry = createPeerSessionRegistry({
    signingSecret: config.signingSecret,
    capacity,
    usage,
    diagnostics: connectionDiagnostics,
  });
  sessionRegistry.attach(peerServer);

  const usageTimer = setInterval(() => {
    writeUsageSummary(usage, connectionDiagnostics);
  }, config.usageLogIntervalSeconds * 1_000);
  usageTimer.unref?.();

  let closePromise: Promise<void> | null = null;

  return {
    app,
    server,
    peerServer,
    close: () => {
      if (closePromise) return closePromise;

      closePromise = (async () => {
        sessionRegistry.stop();
        clearInterval(usageTimer);

        const sockets = [...(peerWebSocketServer?.clients ?? [])];
        const peerWebSocketServerClosed = peerWebSocketServer
          ? new Promise<void>((resolve, reject) => {
              peerWebSocketServer?.close((error) => {
                if (error) reject(error);
                else resolve();
              });
            })
          : Promise.resolve();
        const httpServerClosed = server.listening
          ? new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) reject(error);
                else resolve();
              });
            })
          : Promise.resolve();

        server.closeIdleConnections?.();
        for (const socket of sockets) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(SERVICE_RESTART_CLOSE_CODE, "Service restart");
          } else if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
          }
        }

        await waitForSocketDrain(sockets, SOCKET_DRAIN_TIMEOUT_MS);
        for (const socket of sockets) {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        }

        await Promise.all([peerWebSocketServerClosed, httpServerClosed]);
        writeUsageSummary(usage, connectionDiagnostics);
      })();

      return closePromise;
    },
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
    process.stdout.write(
      "[peerovo] closing active signaling connections for restart\n",
    );
    void runtime.close().then(
      () => process.exit(0),
      () => {
        process.stderr.write("[peerovo] graceful shutdown failed\n");
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    process.stderr.write(`[peerovo] startup failed: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
