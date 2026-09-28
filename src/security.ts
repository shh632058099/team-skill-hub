import type {
  AuthenticationProvider,
  PermissionProvider,
  Principal,
  RepositoryConfig,
  Skill
} from "./types.js";

export class DevelopmentAuthenticationProvider implements AuthenticationProvider {
  constructor(private readonly roles: string[]) {}
  authenticate(): Principal {
    return { id: "development-user", roles: this.roles, tenantId: "default" };
  }
}

export class ApiKeyAuthenticationProvider implements AuthenticationProvider {
  constructor(private readonly principalsByKey: Record<string, Principal>) {}

  authenticate(headers?: Headers): Principal {
    const authorization = headers?.get("authorization");
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const key = headers?.get("x-skill-hub-api-key") ?? bearer;
    if (!key) throw new Error("Authentication required");
    const principal = this.principalsByKey[key];
    if (!principal) throw new Error("Invalid API key");
    return { ...principal, roles: [...principal.roles] };
  }
}

export class StaticRolePermissionProvider implements PermissionProvider {
  private hasAnyRole(principal: Principal, roles: string[]): boolean {
    return roles.length === 0 || roles.some((role) => principal.roles.includes(role));
  }

  allowedRepositories(principal: Principal, repositories: RepositoryConfig[]): RepositoryConfig[] {
    return repositories.filter((repository) => {
      if (!repository.enabled) return false;
      if (!this.hasAnyRole(principal, repository.readRoles)) return false;
      if (repository.visibility.includes("public")) return true;
      if (repository.visibility.includes("internal")) {
        return principal.roles.includes("internal") || principal.roles.includes("developer");
      }
      if (repository.visibility.includes("customer")) return principal.roles.includes("customer");
      return false;
    });
  }

  canReadSkill(principal: Principal, repository: RepositoryConfig, skill: Skill): boolean {
    if (!this.allowedRepositories(principal, [repository]).length) return false;
    if (skill.metadata.visibility.includes("public")) return true;
    if (skill.metadata.visibility.includes("internal")) {
      return principal.roles.includes("internal") || principal.roles.includes("developer");
    }
    if (skill.metadata.visibility.includes("customer")) return principal.roles.includes("customer");
    return false;
  }

  canSyncRepository(principal: Principal, repository: RepositoryConfig): boolean {
    return repository.enabled && this.hasAnyRole(principal, repository.syncRoles);
  }
}
