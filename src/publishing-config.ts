export type PublishingProvider = "gitlab" | "github";

export function defaultPublishingTokenEnv(provider: PublishingProvider): string {
  return provider === "github" ? "GITHUB_TOKEN" : "GITLAB_WRITE_TOKEN";
}

export function normalizePublishingTokenEnv(provider: PublishingProvider, tokenEnv?: string): string {
  const value = tokenEnv?.trim();
  if (!value || value === "GITHUB_TOKEN" || value === "GITLAB_WRITE_TOKEN") {
    return defaultPublishingTokenEnv(provider);
  }
  return value;
}
