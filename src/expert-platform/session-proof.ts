import { createHmac, timingSafeEqual } from "node:crypto";

/** Hook-origin assertion tied to the authenticated MCP credential and one submit call. */
export function verifyClaudeSessionProof(
  credential: string | undefined,
  sessionId: string | undefined,
  idempotencyKey: string,
  proof: string | undefined,
  now = Date.now(),
): boolean {
  if (!credential || !sessionId || !proof || !/^[0-9a-f-]{36}$/.test(sessionId)) return false;
  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(proof);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300_000) return false;
  const expected = createHmac("sha256", credential)
    .update(`team-skill-hub/claude-session/v1\n${sessionId}\n${idempotencyKey}\n${timestamp}`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2]!, "hex"));
}
