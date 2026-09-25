import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter, getClientIp } from "../src/security/rateLimiter.js";

test("limits requests in a fixed window and resets after the window", () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000);
  assert.equal(limiter.consume("ip", 0).allowed, true);
  assert.equal(limiter.consume("ip", 1).allowed, true);
  assert.deepEqual(limiter.consume("ip", 2), {
    allowed: false,
    retryAfterSeconds: 1,
  });
  assert.equal(limiter.consume("ip", 1_000).allowed, true);
});

test("uses forwarded client IPs only when proxy trust is enabled", () => {
  assert.equal(getClientIp("10.0.0.2", "198.51.100.4, 10.0.0.1", false), "10.0.0.2");
  assert.equal(getClientIp("10.0.0.2", "198.51.100.4, 10.0.0.1", true), "198.51.100.4");
  assert.equal(getClientIp(undefined, undefined, false), "unknown");
});
