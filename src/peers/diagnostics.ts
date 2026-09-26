export const CONNECTION_DIAGNOSTIC_REASONS = [
  "invalid_request",
  "invalid_credentials",
  "rate_limited",
  "capacity_reached",
  "admission_unavailable",
  "lease_expired",
  "lease_renewal_unavailable",
  "signaling_server_error",
] as const;

export type ConnectionDiagnosticReason = (typeof CONNECTION_DIAGNOSTIC_REASONS)[number];

export type ConnectionDiagnosticCounts = Record<ConnectionDiagnosticReason, number>;

export interface PeerovoConnectionDiagnostics {
  record(reason: ConnectionDiagnosticReason): void;
  flush(): ConnectionDiagnosticCounts;
}

function emptyCounts(): ConnectionDiagnosticCounts {
  return {
    invalid_request: 0,
    invalid_credentials: 0,
    rate_limited: 0,
    capacity_reached: 0,
    admission_unavailable: 0,
    lease_expired: 0,
    lease_renewal_unavailable: 0,
    signaling_server_error: 0,
  };
}

export function createPeerovoConnectionDiagnostics(): PeerovoConnectionDiagnostics {
  let counts = emptyCounts();

  return {
    record(reason) {
      counts[reason] += 1;
    },
    flush() {
      const snapshot = counts;
      counts = emptyCounts();
      return snapshot;
    },
  };
}
