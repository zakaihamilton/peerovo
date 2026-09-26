export const PEER_CAPACITY_LEASE_MS = 30_000;
export const PEER_CAPACITY_RENEW_INTERVAL_MS = 8_000;

interface PeerOwner {
  peerId: string;
  ownerId: string;
}

interface Lease extends PeerOwner {
  expiresAt: number;
}

function sessionKey(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

function ownerKey(peerId: string, ownerId: string): string {
  return `${peerId}\u0000${ownerId}`;
}

export function createPeerCapacityStore({
  maxPeersPerSession,
  maxPeersPerProject,
  leaseMs = PEER_CAPACITY_LEASE_MS,
  clock = Date.now,
}: {
  maxPeersPerSession: number;
  maxPeersPerProject: number | ((projectId: string) => number);
  leaseMs?: number;
  clock?: () => number;
}) {
  const peersBySession = new Map<string, Map<string, Lease>>();

  function getActivePeers(key: string, now: number): Map<string, Lease> | null {
    const peers = peersBySession.get(key);
    if (!peers) return null;

    for (const [member, lease] of peers) {
      if (lease.expiresAt <= now) peers.delete(member);
    }
    if (peers.size === 0) {
      peersBySession.delete(key);
      return null;
    }
    return peers;
  }

  function activeProjectCount(projectId: string, now: number): number {
    let count = 0;
    const prefix = `${projectId}\u0000`;
    for (const key of peersBySession.keys()) {
      if (!key.startsWith(prefix)) continue;
      count += getActivePeers(key, now)?.size ?? 0;
    }
    return count;
  }

  function projectLimit(projectId: string): number {
    return typeof maxPeersPerProject === "function"
      ? maxPeersPerProject(projectId)
      : maxPeersPerProject;
  }

  return {
    async acquire(
      projectId: string,
      sessionId: string,
      peerId: string,
      ownerId: string,
    ): Promise<boolean> {
      const now = clock();
      const key = sessionKey(projectId, sessionId);
      const peers = getActivePeers(key, now) ?? new Map<string, Lease>();
      const member = ownerKey(peerId, ownerId);
      const alreadyOwned = peers.has(member);
      const duplicatePeer = [...peers.entries()].some(
        ([existingMember, lease]) =>
          existingMember !== member && lease.peerId === peerId,
      );

      if (
        !alreadyOwned &&
        (duplicatePeer ||
          peers.size >= maxPeersPerSession ||
          activeProjectCount(projectId, now) >= projectLimit(projectId))
      ) {
        return false;
      }

      peers.set(member, { peerId, ownerId, expiresAt: now + leaseMs });
      peersBySession.set(key, peers);
      return true;
    },

    async renew(
      projectId: string,
      sessionId: string,
      owners: PeerOwner[],
    ): Promise<string[]> {
      const key = sessionKey(projectId, sessionId);
      const peers = getActivePeers(key, clock());
      if (!peers) return [];

      const renewed: string[] = [];
      for (const owner of owners) {
        const member = ownerKey(owner.peerId, owner.ownerId);
        const current = peers.get(member);
        if (!current) continue;
        peers.set(member, { ...current, expiresAt: clock() + leaseMs });
        renewed.push(owner.ownerId);
      }
      return renewed;
    },

    async release(
      projectId: string,
      sessionId: string,
      peerId: string,
      ownerId: string,
    ): Promise<void> {
      const key = sessionKey(projectId, sessionId);
      const peers = getActivePeers(key, clock());
      if (!peers) return;
      peers.delete(ownerKey(peerId, ownerId));
      if (peers.size === 0) peersBySession.delete(key);
    },

    activeCount(projectId: string, sessionId: string): number {
      return getActivePeers(sessionKey(projectId, sessionId), clock())?.size ?? 0;
    },

    activeCountForProject(projectId: string): number {
      return activeProjectCount(projectId, clock());
    },
  };
}
