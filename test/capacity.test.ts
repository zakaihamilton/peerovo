import assert from "node:assert/strict";
import test from "node:test";
import { createPeerCapacityStore } from "../src/peers/capacity.js";

test("enforces per-session capacity, duplicate peer protection, and release", async () => {
  const store = createPeerCapacityStore({
    maxPeersPerSession: 2,
    maxPeersPerProject: 10,
  });
  assert.equal(await store.acquire("p1", "s1", "peer1", "owner1"), true);
  assert.equal(await store.acquire("p1", "s1", "peer1", "owner2"), false);
  assert.equal(await store.acquire("p1", "s1", "peer2", "owner2"), true);
  assert.equal(await store.acquire("p1", "s1", "peer3", "owner3"), false);
  assert.equal(await store.acquire("p2", "s1", "peer3", "owner3"), true);

  await store.release("p1", "s1", "peer1", "owner1");
  assert.equal(await store.acquire("p1", "s1", "peer3", "owner3"), true);
  assert.equal(store.activeCount("p1", "s1"), 2);
});

test("expires abandoned reservations and renews active leases", async () => {
  let now = 1_000;
  const store = createPeerCapacityStore({
    maxPeersPerSession: 1,
    maxPeersPerProject: 2,
    leaseMs: 30,
    clock: () => now,
  });

  assert.equal(await store.acquire("p", "s", "peer1", "owner1"), true);
  now += 20;
  assert.deepEqual(
    await store.renew("p", "s", [{ peerId: "peer1", ownerId: "owner1" }]),
    ["owner1"],
  );
  now += 20;
  assert.equal(await store.acquire("p", "s", "peer2", "owner2"), false);
  now += 11;
  assert.equal(await store.acquire("p", "s", "peer2", "owner2"), true);
});

test("caps peers across sessions per project while isolating other projects", async () => {
  const store = createPeerCapacityStore({
    maxPeersPerSession: 2,
    maxPeersPerProject: (projectId) => (projectId === "small" ? 1 : 2),
  });

  assert.equal(await store.acquire("small", "session-1", "peer-1", "owner-1"), true);
  assert.equal(await store.acquire("small", "session-2", "peer-2", "owner-2"), false);
  assert.equal(await store.acquire("large", "session-1", "peer-1", "owner-1"), true);
  assert.equal(await store.acquire("large", "session-2", "peer-2", "owner-2"), true);
  assert.equal(await store.acquire("large", "session-3", "peer-3", "owner-3"), false);
  assert.equal(store.activeCountForProject("small"), 1);
  assert.equal(store.activeCountForProject("large"), 2);

  await store.release("small", "session-1", "peer-1", "owner-1");
  assert.equal(await store.acquire("small", "session-2", "peer-2", "owner-2"), true);
});

test("expired session leases stop consuming the project cap", async () => {
  let now = 1_000;
  const store = createPeerCapacityStore({
    maxPeersPerSession: 2,
    maxPeersPerProject: 1,
    leaseMs: 30,
    clock: () => now,
  });

  assert.equal(await store.acquire("p", "old-session", "peer-1", "owner-1"), true);
  now += 31;
  assert.equal(await store.acquire("p", "new-session", "peer-2", "owner-2"), true);
  assert.equal(store.activeCountForProject("p"), 1);
});

test("allows the same ticket owner to reconnect at the project cap", async () => {
  const store = createPeerCapacityStore({
    maxPeersPerSession: 1,
    maxPeersPerProject: 1,
  });

  assert.equal(await store.acquire("p", "s", "peer-1", "ticket-owner"), true);
  assert.equal(await store.acquire("p", "s", "peer-1", "ticket-owner"), true);
  assert.equal(store.activeCountForProject("p"), 1);
});
