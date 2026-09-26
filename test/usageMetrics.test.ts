import assert from "node:assert/strict";
import test from "node:test";
import { createPeerovoUsageTracker } from "../src/usage/metrics.js";

test("summarizes project usage without losing the active peer count", () => {
  let now = 1_000;
  const usage = createPeerovoUsageTracker(["alpha", "beta"], () => now);

  usage.recordTicketRequest("alpha");
  usage.recordTicketRequest("alpha");
  usage.recordTicketIssued("alpha");
  usage.recordRateLimited("ticket", "alpha");
  usage.recordIceConfigRequest("alpha");
  usage.recordIceConfigIssued("alpha");
  usage.recordSignalingAttempt("alpha");
  usage.recordSignalingAdmission("alpha", true);
  usage.recordSignalingAdmission("beta", false);
  usage.recordSignalingRateLimited();
  usage.recordPeerConnected("alpha");
  usage.recordPeerConnected("alpha");
  usage.recordPeerDisconnected("alpha");
  now += 5_000;

  const summary = usage.flush();
  assert.equal(summary.event, "usage_summary");
  assert.equal(summary.periodSeconds, 5);
  assert.equal(summary.signalingRateLimited, 1);
  assert.deepEqual(summary.projects, [
    {
      projectId: "alpha",
      ticketRequests: 2,
      ticketsIssued: 1,
      ticketRateLimited: 1,
      iceConfigRequests: 1,
      iceConfigsIssued: 1,
      iceRateLimited: 0,
      signalingAttempts: 1,
      signalingAdmitted: 1,
      signalingAdmissionRejected: 0,
      activePeers: 1,
      peakActivePeers: 2,
    },
    {
      projectId: "beta",
      ticketRequests: 0,
      ticketsIssued: 0,
      ticketRateLimited: 0,
      iceConfigRequests: 0,
      iceConfigsIssued: 0,
      iceRateLimited: 0,
      signalingAttempts: 0,
      signalingAdmitted: 0,
      signalingAdmissionRejected: 1,
      activePeers: 0,
      peakActivePeers: 0,
    },
  ]);

  now += 1_000;
  const nextSummary = usage.flush();
  assert.equal(nextSummary.projects[0]?.activePeers, 1);
  assert.equal(nextSummary.projects[0]?.peakActivePeers, 1);
  assert.equal(nextSummary.projects[0]?.ticketsIssued, 0);
  assert.equal(nextSummary.signalingRateLimited, 0);
});
