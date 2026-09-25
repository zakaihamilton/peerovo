import { timingSafeEqual } from "node:crypto";

export const MAX_PROJECT_KEY_LENGTH = 2_048;

export function extractBearerToken(header: string | undefined): string | null {
  if (!header || header.length > MAX_PROJECT_KEY_LENGTH + 16) return null;
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function matchesProjectKey(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || received.length > MAX_PROJECT_KEY_LENGTH) {
    return false;
  }
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes)
  );
}
