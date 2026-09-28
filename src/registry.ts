import type { RegistryStore, Skill } from "./types.js";

export class MemoryRegistryStore implements RegistryStore {
  private readonly skills = new Map<string, Skill>();

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(repositoryId: string, name: string): Skill | undefined {
    return this.skills.get(`${repositoryId}:${name}`);
  }

  replaceRepository(repositoryId: string, skills: Skill[]): void {
    for (const [key, skill] of this.skills) {
      if (skill.repositoryId === repositoryId) this.skills.delete(key);
    }
    for (const skill of skills) this.skills.set(skill.key, skill);
  }

  serialize(): unknown {
    return { skills: this.list() };
  }

  hydrate(value: unknown): void {
    if (!value || typeof value !== "object" || !Array.isArray((value as { skills?: unknown }).skills)) {
      return;
    }
    this.skills.clear();
    for (const item of (value as { skills: Skill[] }).skills) {
      if (item?.key) this.skills.set(item.key, item);
    }
  }
}
