export type PolicyDecision = "allow" | "deny";

export interface PreToolPolicyInput {
  toolName: string;
  operation?: string;
  command?: string;
  environment?: string;
  repositoryVisibility?: string[];
  roles?: string[];
  confirmed?: boolean;
}

export interface PolicyMatch {
  rule:
    | "secret-detection"
    | "destructive-command"
    | "production-confirmation"
    | "customer-repository-guard"
    | "restricted-environment";
  decision: PolicyDecision;
  reason: string;
}

export interface PreToolPolicyResult {
  decision: PolicyDecision;
  reasons: string[];
  matches: PolicyMatch[];
}

const SECRET_PATTERNS = [
  /(?:skh_|sk-|ghp_|glpat-)[A-Za-z0-9_-]{8,}/i,
  /(?:password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i
];

const DESTRUCTIVE_PATTERNS = [
  /(?:^|[;&|]\s*)rm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\s]*[fd][^\s]*\b/i,
  /\b(?:mkfs|diskpart|format)\b/i,
  /\bRemove-Item\b[^\r\n]*(?:-Recurse[^\r\n]*-Force|-Force[^\r\n]*-Recurse)/i
];

const WRITE_OPERATIONS = /(?:write|edit|delete|remove|deploy|release|publish|merge|push|reset|clean|format)/i;

export function evaluatePreToolPolicy(input: PreToolPolicyInput): PreToolPolicyResult {
  const matches: PolicyMatch[] = [];
  const command = input.command ?? "";
  const operation = [input.operation, input.toolName, command].filter(Boolean).join(" ");
  const confirmed = input.confirmed === true;
  const roles = new Set(input.roles ?? []);
  const environment = input.environment?.toLowerCase();

  if (SECRET_PATTERNS.some((pattern) => pattern.test(command))) {
    matches.push({ rule: "secret-detection", decision: "deny", reason: "tool input appears to contain a literal credential or private key" });
  }
  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) && !confirmed) {
    matches.push({ rule: "destructive-command", decision: "deny", reason: "destructive command requires explicit confirmation" });
  }
  if ((environment === "prod" || environment === "production") && WRITE_OPERATIONS.test(operation) && !confirmed) {
    matches.push({ rule: "production-confirmation", decision: "deny", reason: "production write operation requires explicit confirmation" });
  }
  if (
    input.repositoryVisibility?.includes("customer") &&
    WRITE_OPERATIONS.test(operation) &&
    !roles.has("customer-write") &&
    !roles.has("admin")
  ) {
    matches.push({ rule: "customer-repository-guard", decision: "deny", reason: "customer repository write requires customer-write or admin role" });
  }
  if (
    (environment === "restricted" || environment === "secure") &&
    WRITE_OPERATIONS.test(operation) &&
    !roles.has("restricted-env") &&
    !roles.has("admin")
  ) {
    matches.push({ rule: "restricted-environment", decision: "deny", reason: "restricted environment write requires restricted-env or admin role" });
  }
  return {
    decision: matches.some((item) => item.decision === "deny") ? "deny" : "allow",
    reasons: matches.map((item) => item.reason),
    matches
  };
}
