export type RateLimitedArea = "ticket" | "ice";

export interface ProjectUsageSnapshot {
  projectId: string;
  ticketRequests: number;
  ticketsIssued: number;
  ticketRateLimited: number;
  iceConfigRequests: number;
  iceConfigsIssued: number;
  iceRateLimited: number;
  signalingAttempts: number;
  signalingAdmitted: number;
  signalingAdmissionRejected: number;
  activePeers: number;
  peakActivePeers: number;
}

export interface UsageSummary {
  event: "usage_summary";
  emittedAt: string;
  periodSeconds: number;
  signalingRateLimited: number;
  projects: ProjectUsageSnapshot[];
}

export interface PeerovoUsageTracker {
  recordTicketRequest(projectId: string): void;
  recordTicketIssued(projectId: string): void;
  recordIceConfigRequest(projectId: string): void;
  recordIceConfigIssued(projectId: string): void;
  recordRateLimited(area: RateLimitedArea, projectId: string): void;
  recordSignalingAttempt(projectId: string): void;
  recordSignalingAdmission(projectId: string, admitted: boolean): void;
  recordSignalingRateLimited(): void;
  recordPeerConnected(projectId: string): void;
  recordPeerDisconnected(projectId: string): void;
  flush(): UsageSummary;
}

type MutableProjectUsage = Omit<ProjectUsageSnapshot, "projectId">;

function emptyProjectUsage(): MutableProjectUsage {
  return {
    ticketRequests: 0,
    ticketsIssued: 0,
    ticketRateLimited: 0,
    iceConfigRequests: 0,
    iceConfigsIssued: 0,
    iceRateLimited: 0,
    signalingAttempts: 0,
    signalingAdmitted: 0,
    signalingAdmissionRejected: 0,
    activePeers: 0,
    peakActivePeers: 0,
  };
}

export function createPeerovoUsageTracker(
  projectIds: Iterable<string>,
  clock: () => number = Date.now,
): PeerovoUsageTracker {
  const projects = new Map<string, MutableProjectUsage>();
  for (const projectId of projectIds) {
    projects.set(projectId, emptyProjectUsage());
  }
  let periodStartedAt = clock();
  let signalingRateLimited = 0;

  function usageFor(projectId: string): MutableProjectUsage {
    let usage = projects.get(projectId);
    if (!usage) {
      usage = emptyProjectUsage();
      projects.set(projectId, usage);
    }
    return usage;
  }

  return {
    recordTicketRequest(projectId) {
      usageFor(projectId).ticketRequests += 1;
    },
    recordTicketIssued(projectId) {
      usageFor(projectId).ticketsIssued += 1;
    },
    recordIceConfigRequest(projectId) {
      usageFor(projectId).iceConfigRequests += 1;
    },
    recordIceConfigIssued(projectId) {
      usageFor(projectId).iceConfigsIssued += 1;
    },
    recordRateLimited(area, projectId) {
      const usage = usageFor(projectId);
      if (area === "ticket") usage.ticketRateLimited += 1;
      else usage.iceRateLimited += 1;
    },
    recordSignalingAttempt(projectId) {
      usageFor(projectId).signalingAttempts += 1;
    },
    recordSignalingAdmission(projectId, admitted) {
      const usage = usageFor(projectId);
      if (admitted) usage.signalingAdmitted += 1;
      else usage.signalingAdmissionRejected += 1;
    },
    recordSignalingRateLimited() {
      signalingRateLimited += 1;
    },
    recordPeerConnected(projectId) {
      const usage = usageFor(projectId);
      usage.activePeers += 1;
      usage.peakActivePeers = Math.max(usage.peakActivePeers, usage.activePeers);
    },
    recordPeerDisconnected(projectId) {
      const usage = usageFor(projectId);
      usage.activePeers = Math.max(0, usage.activePeers - 1);
    },
    flush() {
      const now = clock();
      const snapshots = [...projects.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([projectId, usage]) => ({ projectId, ...usage }));
      const summary: UsageSummary = {
        event: "usage_summary",
        emittedAt: new Date(now).toISOString(),
        periodSeconds: Math.max(0, Math.round((now - periodStartedAt) / 1_000)),
        signalingRateLimited,
        projects: snapshots,
      };

      for (const usage of projects.values()) {
        const activePeers = usage.activePeers;
        Object.assign(usage, emptyProjectUsage(), {
          activePeers,
          peakActivePeers: activePeers,
        });
      }
      signalingRateLimited = 0;
      periodStartedAt = now;
      return summary;
    },
  };
}
