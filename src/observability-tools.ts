export const REUSE_MCP_TOOLS = new Set([
  "discover",
  "search_knowledge",
  "get_knowledge",
  "search_skills",
  "get_skill",
  "get_skill_resource",
  "resolve_skill",
  "knowledge_search",
  "skill_search",
]);
export function isReuseMcpTool(tool: string): boolean {
  return REUSE_MCP_TOOLS.has(tool);
}
