import { createHmac, timingSafeEqual } from "node:crypto";

/** Hook-origin assertion tied to the authenticated MCP credential and one submit call. */
export function verifyClientSessionProof(
  credential: string | undefined,
  sessionId: string | undefined,
  idempotencyKey: string,
  proof: string | undefined,
  now = Date.now(),
  sourceRequestId?: string,
): boolean {
  if (!credential || !sessionId || !proof || !/^[0-9a-f-]{36}$/.test(sessionId)) return false;
  if (sourceRequestId !== undefined && !/^srq_[a-f0-9]{64}$/.test(sourceRequestId)) return false;
  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(proof);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 300_000) return false;
  const supplied = Buffer.from(match[2]!, "hex");
  const messages = sourceRequestId
    ? [`team-skill-hub/client-session/v2\n${sessionId}\n${sourceRequestId}\n${idempotencyKey}\n${timestamp}`]
    : [
        `team-skill-hub/client-session/v1\n${sessionId}\n${idempotencyKey}\n${timestamp}`,
        `team-skill-hub/claude-session/v1\n${sessionId}\n${idempotencyKey}\n${timestamp}`,
      ];
  return messages.some((message) => {
    const expected = createHmac("sha256", credential).update(message).digest();
    return timingSafeEqual(expected, supplied);
  });
}

/** @deprecated Use verifyClientSessionProof. Kept for downstream compatibility. */
export const verifyClaudeSessionProof = verifyClientSessionProof;
