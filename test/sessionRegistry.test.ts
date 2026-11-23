import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { IClient, PeerServerEvents } from "peer";
import { WebSocket } from "ws";
import { issuePeerToken } from "../src/auth/peerToken.js";
import { createPeerovoConnectionDiagnostics } from "../src/peers/diagnostics.js";
import {
  createPeerSessionRegistry,
  type PeerLeaseCapacity,
  type PeerovoWebSocket,
} from "../src/peers/sessionRegistry.js";
import { createPeerovoUsageTracker } from "../src/usage/metrics.js";
import { testConfig } from "./helpers.js";

function createMockSocket(readyState = WebSocket.OPEN) {
  const closed: Array<{ code: number; reason: string }> = [];
  let terminated = false;
  const socket = {
    readyState,
    close(code: number, reason: string) {
      closed.push({ code, reason });
    },
    terminate() {
      terminated = true;
    },
  } as unknown as PeerovoWebSocket;
  return {
    socket,
    closed,
    wasTerminated: () => terminated,
  };
}

function createMockClient({
  id,
  token,
  socket,
}: {
  id: string;
  token: string;
  socket: PeerovoWebSocket | null;
}): IClient {
  return {
    getId: () => id,
    getToken: () => token,
    getSocket: () => socket,
  } as unknown as IClient;
}

test("rejects missing or mismatched admission and releases the reservation", async () => {
  const config = testConfig();
  const released: Array<{
    projectId: string;
    sessionId: string;
    peerId: string;
    ownerId: string;
  }> = [];
  const capacity: PeerLeaseCapacity = {
    renew: async () => [],
    release: async (projectId, sessionId, peerId, ownerId) => {
      released.push({ projectId, sessionId, peerId, ownerId });
    },
  };
  const usage = createPeerovoUsageTracker(config.projects.keys());
  const diagnostics = createPeerovoConnectionDiagnostics();
  const registry = createPeerSessionRegistry({
    signingSecret: config.signingSecret,
    capacity,
    usage,
    diagnostics,
  });

  const issued = issuePeerToken({
    projectId: "sample",
    sessionId: "session-1",
    peerId: "peer-1",
    secret: config.signingSecret,
  });
  const wrongClaim = issuePeerToken({
    projectId: "sample",
    sessionId: "session-1",
    peerId: "peer-2",
    secret: config.signingSecret,
  });

  const { socket, closed } = createMockSocket();
  socket.peerovoAdmission = { claims: wrongClaim.claims, ownerId: "owner-wrong" };
  registry.handleConnection(
    createMockClient({ id: "peer-1", token: issued.token, socket }),
  );

  assert.deepEqual(closed, [{ code: 1011, reason: "Peer admission is invalid" }]);
  assert.deepEqual(released, [
    {
      projectId: "sample",
      sessionId: "session-1",
      peerId: "peer-2",
      ownerId: "owner-wrong",
    },
  ]);
  assert.equal(usage.flush().projects[0]?.activePeers, 0);
});

test("tracks connect, reconnect replacement, and disconnect lifecycle", async () => {
  const config = testConfig();
  const released: string[] = [];
  const capacity: PeerLeaseCapacity = {
    renew: async (_p, _s, owners) => owners.map((o) => o.ownerId),
    release: async (_p, _s, peerId, ownerId) => {
      released.push(`${peerId}:${ownerId}`);
    },
  };
  const usage = createPeerovoUsageTracker(config.projects.keys());
  const diagnostics = createPeerovoConnectionDiagnostics();
  const registry = createPeerSessionRegistry({
    signingSecret: config.signingSecret,
    capacity,
    usage,
    diagnostics,
  });

  const emitter = new EventEmitter();
  registry.attach(emitter as unknown as PeerServerEvents);

  const issued = issuePeerToken({
    projectId: "sample",
    sessionId: "session-1",
    peerId: "peer-1",
    secret: config.signingSecret,
  });

  const first = createMockSocket();
  first.socket.peerovoAdmission = { claims: issued.claims, ownerId: "owner-1" };
  const firstClient = createMockClient({
    id: "peer-1",
    token: issued.token,
    socket: first.socket,
  });
  emitter.emit("connection", firstClient);

  const second = createMockSocket();
  second.socket.peerovoAdmission = { claims: issued.claims, ownerId: "owner-2" };
  const secondClient = createMockClient({
    id: "peer-1",
    token: issued.token,
    socket: second.socket,
  });
  emitter.emit("connection", secondClient);

  assert.equal(first.wasTerminated(), true);
  assert.deepEqual(released, ["peer-1:owner-1"]);

  // Stale disconnect for replaced client is ignored.
  emitter.emit("disconnect", firstClient);
  assert.equal(usage.flush().projects[0]?.activePeers, 1);

  emitter.emit("disconnect", secondClient);
  assert.equal(usage.flush().projects[0]?.activePeers, 0);
  assert.deepEqual(released, ["peer-1:owner-1", "peer-1:owner-2"]);

  registry.stop();
});

test("renews active leases, expires missing owners, and tolerates transient errors", async () => {
  const config = testConfig();
  let mode: "ok" | "expired" | "fail" = "fail";
  const capacity: PeerLeaseCapacity = {
    renew: async (_p, _s, owners) => {
      if (mode === "fail") throw new Error("store unavailable");
      if (mode === "expired") return [];
      return owners.map((o) => o.ownerId);
    },
    release: async () => {},
  };
  const usage = createPeerovoUsageTracker(config.projects.keys());
  const diagnostics = createPeerovoConnectionDiagnostics();
  const registry = createPeerSessionRegistry({
    signingSecret: config.signingSecret,
    capacity,
    usage,
    diagnostics,
    maxLeaseRenewalFailures: 2,
  });

  const issued = issuePeerToken({
    projectId: "sample",
    sessionId: "session-1",
    peerId: "peer-1",
    secret: config.signingSecret,
  });
  const { socket, closed } = createMockSocket();
  socket.peerovoAdmission = { claims: issued.claims, ownerId: "owner-1" };
  registry.handleConnection(
    createMockClient({ id: "peer-1", token: issued.token, socket }),
  );

  await registry.renewLeases();
  assert.equal(closed.length, 0);

  mode = "ok";
  await registry.renewLeases();
  mode = "fail";
  await registry.renewLeases();
  assert.equal(closed.length, 0);

  await registry.renewLeases();
  assert.deepEqual(closed, [{ code: 1013, reason: "Session admission unavailable" }]);

  mode = "expired";
  await registry.renewLeases();
  assert.equal(closed.length, 2);
  assert.deepEqual(closed[1], {
    code: 1013,
    reason: "Session admission lease expired",
  });

  registry.handleError(new Error("boom"));
  const counts = diagnostics.flush();
  assert.equal(counts.lease_renewal_unavailable, 1);
  assert.equal(counts.lease_expired, 1);
  assert.equal(counts.signaling_server_error, 1);
});
