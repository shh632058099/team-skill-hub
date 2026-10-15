function message(decision, detail) {
  if (decision === "optional_update") return `Team Skill Hub client integration update available: v${detail.installed} -> v${detail.latest}. Say "升级 Team Skill Hub" to install it.`;
  if (decision === "required_update") return `Team Skill Hub client integration v${detail.installed} is no longer supported. Minimum required version: v${detail.minimum}. Please upgrade before using Team Skill Hub operations that depend on the new client integration.`;
  return "";
}
export function renderTerminalNotice(decision, detail) {
  const text = message(decision, detail);
  return text ? `⚠ ${text}` : "";
}
export function renderClaudeDecision(decision, detail) {
  const additionalContext = message(decision, detail);
  if (!additionalContext) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}
