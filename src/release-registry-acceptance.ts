export interface RegistryAcceptanceOptions {
  releaseImage: string;
  shaImage: string;
  rollbackImage: string;
  expectedVersion: string;
}

export interface DockerCommandRunner {
  run(args: string[]): Promise<string>;
}

export interface RegistryAcceptanceReport {
  ok: true;
  releaseImage: string;
  shaImage: string;
  rollbackImage: string;
  expectedVersion: string;
  imageVersion: string;
  releaseImageId: string;
  shaImageId: string;
  rollbackImageId: string;
  releaseDigests: string[];
  shaDigests: string[];
  rollbackDigests: string[];
}

function assertImmutableReference(value: string, label: string): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith(":latest") || (!trimmed.includes(":") && !trimmed.includes("@sha256:"))) {
    throw new Error(label + " must be an immutable tag or digest reference, not latest");
  }
}

function parseDigests(value: string, label: string): string[] {
  const text = value.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(label + " RepoDigests output is not valid JSON");
  }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((item) => typeof item === "string" && item.includes("@sha256:"))) {
    throw new Error(label + " has no immutable registry digest evidence");
  }
  return parsed as string[];
}

export async function validateRegistryRelease(
  options: RegistryAcceptanceOptions,
  docker: DockerCommandRunner
): Promise<RegistryAcceptanceReport> {
  assertImmutableReference(options.releaseImage, "release image");
  assertImmutableReference(options.shaImage, "SHA image");
  assertImmutableReference(options.rollbackImage, "rollback image");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(options.expectedVersion)) {
    throw new Error("expectedVersion must be a semantic version");
  }
  if (options.releaseImage === options.rollbackImage) {
    throw new Error("rollback image must differ from release image");
  }

  for (const image of [options.releaseImage, options.shaImage, options.rollbackImage]) {
    await docker.run(["pull", image]);
  }

  const inspectId = async (image: string): Promise<string> => {
    const id = (await docker.run(["image", "inspect", "--format", "{{.Id}}", image])).trim();
    if (!id.startsWith("sha256:")) throw new Error("Image " + image + " did not return a content-addressed image id");
    return id;
  };
  const inspectDigests = async (image: string): Promise<string[]> =>
    parseDigests(await docker.run(["image", "inspect", "--format", "{{json .RepoDigests}}", image]), image);

  const releaseImageId = await inspectId(options.releaseImage);
  const shaImageId = await inspectId(options.shaImage);
  const rollbackImageId = await inspectId(options.rollbackImage);
  if (releaseImageId !== shaImageId) {
    throw new Error("Release tag and SHA tag do not resolve to the same built image");
  }

  const releaseDigests = await inspectDigests(options.releaseImage);
  const shaDigests = await inspectDigests(options.shaImage);
  const rollbackDigests = await inspectDigests(options.rollbackImage);

  const imageVersion = (
    await docker.run([
      "run",
      "--rm",
      "--entrypoint",
      "node",
      options.releaseImage,
      "-p",
      "require('/app/package.json').version"
    ])
  ).trim();
  if (imageVersion !== options.expectedVersion) {
    throw new Error("Release image package version " + imageVersion + " does not match expected " + options.expectedVersion);
  }

  return {
    ok: true,
    releaseImage: options.releaseImage,
    shaImage: options.shaImage,
    rollbackImage: options.rollbackImage,
    expectedVersion: options.expectedVersion,
    imageVersion,
    releaseImageId,
    shaImageId,
    rollbackImageId,
    releaseDigests,
    shaDigests,
    rollbackDigests
  };
}
