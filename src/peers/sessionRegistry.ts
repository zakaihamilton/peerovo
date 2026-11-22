import type { IClient, PeerServerEvents } from "peer";
import { WebSocket } from "ws";
import {
  isPeerAuthorizedForClaims,
  type PeerClaims,
  verifyPeerToken,
} from "../auth/peerToken.js";
import type { PeerovoUsageTracker } from "../usage/metrics.js";
import { PEER_CAPACITY_RENEW_INTERVAL_MS } from "./capacity.js";
import type { PeerovoConnectionDiagnostics } from "./diagnostics.js";
import type { Admission } from "./upgradeAuth.js";

export interface PeerovoWebSocket extends WebSocket {
  peerovoAdmission?: Admission;
}

interface ActivePeer {
  client: IClient;
  socket: WebSocket | null;
  claims: PeerClaims;
  ownerId: string;
  renewalFailures: number;
}

interface ActiveSession {
  projectId: string;
  sessionId: string;
  peers: Map<string, ActivePeer>;
}

export interface PeerLeaseCapacity {
  renew(
    projectId: string,
    sessionId: string,
    owners: Array<{ peerId: string; ownerId: string }>,
  ): Promise<string[]>;
  release(
    projectId: string,
    sessionId: string,
    peerId: string,
    ownerId: string,
  ): Promise<void>;
}

export interface PeerSessionRegistryOptions {
  signingSecret: string;
  capacity: PeerLeaseCapacity;
  usage: PeerovoUsageTracker;
  diagnostics: PeerovoConnectionDiagnostics;
  renewIntervalMs?: number;
  maxLeaseRenewalFailures?: number;
}

export interface PeerSessionRegistry {
  attach(peerServer: PeerServerEvents): void;
  handleConnection(client: IClient): void;
  handleDisconnect(client: IClient): void;
  handleError(error: Error): void;
  renewLeases(): Promise<void>;
  startRenewal(): void;
  stop(): void;
}

const MAX_LEASE_RENEWAL_FAILURES = 3;

export function safeErrorType(error: Error): string {
  return /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(error.name) ? error.name : "Error";
}

function closePeerForAdmissionFailure(entry: ActivePeer, reason: string): boolean {
  const socket = entry.client.getSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.close(1013, reason);
  return true;
}

function activeSessionKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

export function createPeerSessionRegistry({
  signingSecret,
  capacity,
  usage,
  diagnostics,
  renewIntervalMs = PEER_CAPACITY_RENEW_INTERVAL_MS,
  maxLeaseRenewalFailures = MAX_LEASE_RENEWAL_FAILURES,
}: PeerSessionRegistryOptions): PeerSessionRegistry {
  const activePeersBySession = new Map<string, ActiveSession>();
  let renewalInFlight = false;
  let renewalTimer: ReturnType<typeof setInterval> | null = null;

  function handleConnection(client: IClient): void {
    const claims = verifyPeerToken(client.getToken(), signingSecret);
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
      if (admission) {
        void capacity
          .release(
            admission.claims.projectId,
            admission.claims.sessionId,
            admission.claims.peerId,
            admission.ownerId,
          )
          .catch(() => {});
      }
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
      socket,
      claims,
      ownerId: admission.ownerId,
      renewalFailures: 0,
    };
    activeSession.peers.set(client.getId(), entry);
    if (!previous) usage.recordPeerConnected(claims.projectId);
    if (
      previous?.socket &&
      previous.socket !== socket &&
      previous.socket.readyState === WebSocket.OPEN
    ) {
      previous.socket.terminate();
    }
    if (previous && previous.ownerId !== entry.ownerId) {
      void capacity
        .release(
          previous.claims.projectId,
          previous.claims.sessionId,
          client.getId(),
          previous.ownerId,
        )
        .catch(() => {});
    }
  }

  function handleDisconnect(client: IClient): void {
    const claims = verifyPeerToken(client.getToken(), signingSecret);
    if (!claims) return;
    const key = activeSessionKey(claims.projectId, claims.sessionId);
    const activeSession = activePeersBySession.get(key);
    const entry = activeSession?.peers.get(client.getId());
    if (!activeSession || !entry || entry.client !== client) {
      return;
    }

    activeSession.peers.delete(client.getId());
    if (activeSession.peers.size === 0) activePeersBySession.delete(key);
    usage.recordPeerDisconnected(claims.projectId);
    void capacity
      .release(claims.projectId, claims.sessionId, client.getId(), entry.ownerId)
      .catch(() => {});
  }

  function handleError(error: Error): void {
    // PeerJS errors can be triggered by untrusted signaling traffic. Avoid
    // logging request URLs, ticket values, or library error details.
    diagnostics.record("signaling_server_error");
    process.stderr.write(
      `[peerovo] signaling server error type=${safeErrorType(error)}\n`,
    );
  }

  async function renewLeases(): Promise<void> {
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
            if (
              entry.renewalFailures >= maxLeaseRenewalFailures &&
              closePeerForAdmissionFailure(entry, "Session admission unavailable")
            ) {
              diagnostics.record("lease_renewal_unavailable");
            }
          }
          return;
        }

        for (const [peerId, entry] of activeSession.peers) {
          if (activeSession.peers.get(peerId) !== entry) continue;
          if (!renewedOwnerIds.has(entry.ownerId)) {
            if (
              closePeerForAdmissionFailure(entry, "Session admission lease expired")
            ) {
              diagnostics.record("lease_expired");
            }
            continue;
          }
          entry.renewalFailures = 0;
        }
      }),
    );
  }

  function startRenewal(): void {
    if (renewalTimer) return;
    renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void (async () => {
        try {
          await renewLeases();
        } finally {
          renewalInFlight = false;
        }
      })();
    }, renewIntervalMs);
    renewalTimer.unref?.();
  }

  function stop(): void {
    if (!renewalTimer) return;
    clearInterval(renewalTimer);
    renewalTimer = null;
  }

  return {
    attach(peerServer) {
      peerServer.on("connection", handleConnection);
      peerServer.on("disconnect", handleDisconnect);
      peerServer.on("error", handleError);
      startRenewal();
    },
    handleConnection,
    handleDisconnect,
    handleError,
    renewLeases,
    startRenewal,
    stop,
  };
}
