/**
 * Pure version-computation logic for the Release workflow.
 *
 * No side effects (no git, no fs, no env) so it is unit-tested directly in
 * test/release-version.test.ts. The CLI in cli.ts wires these functions to the
 * real git tags / package.json / GitHub env.
 */

export type VersionBump = "patch" | "minor" | "major";

export interface ReleaseVersion {
  /** The bare `X.Y.Z` version that will be written into package.json and published. */
  version: string;
  /** The git tag for this release, always `v${version}`. */
  tagName: string;
  /** The latest pre-existing stable tag (`vX.Y.Z`), or `""` when none exist yet. */
  previousTag: string;
}

function isNumericSegment(segment: string): boolean {
  if (segment === "") return false;
  for (const char of segment) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

/** A stable release version is exactly three numeric segments (no pre-release / build metadata). */
export function isStableSemver(version: string): boolean {
  const segments = version.split(".");
  return segments.length === 3 && segments.every(isNumericSegment);
}

/** Returns the bare version for a stable `vX.Y.Z` tag, or `undefined` for anything else. */
export function parseStableTag(tag: string): string | undefined {
  if (!tag.startsWith("v")) return undefined;
  const version = tag.slice(1);
  return isStableSemver(version) ? version : undefined;
}

/** Accepts `1.2.3` or `v1.2.3`, returns the bare `1.2.3`, throws on anything non-stable. */
export function normalizeExpectedVersion(expectedVersion: string): string {
  const normalized = expectedVersion.startsWith("v")
    ? expectedVersion.slice(1)
    : expectedVersion;
  if (!isStableSemver(normalized)) {
    throw new Error(`Expected version must use the X.Y.Z format, got: ${expectedVersion}`);
  }
  return normalized;
}

/**
 * Returns the newest stable tag from a list. Tags are assumed to arrive newest-first
 * (the CLI sorts with `git tag --sort=-v:refname`), so this returns the first stable one.
 */
export function findLatestStableTag(tags: readonly string[]): string {
  for (const tag of tags) {
    if (parseStableTag(tag) !== undefined) return tag;
  }
  return "";
}

function parseSegments(version: string): [number, number, number] {
  const segments = version.split(".");
  if (segments.length !== 3 || !segments.every(isNumericSegment)) {
    throw new Error(`Cannot bump invalid version: ${version}`);
  }
  return [Number(segments[0]), Number(segments[1]), Number(segments[2])];
}

export function bumpVersion(version: string, bump: VersionBump): string {
  const [major, minor, patch] = parseSegments(version);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function readVersionBump(value: string | undefined): VersionBump {
  if (value === "patch" || value === "minor" || value === "major") return value;
  throw new Error(`Unsupported version bump: ${value ?? "(empty)"}`);
}

/**
 * Resolves the version to release.
 *
 * - When `expectedVersion` is non-empty it wins verbatim (after `X.Y.Z` validation).
 * - Otherwise the version is bumped from the latest stable tag; with no tags yet it
 *   bumps from `baseVersion` (the committed package.json version), falling back to
 *   `0.0.0` if that is not a stable semver.
 *
 * Throws when the resulting tag already exists, so a re-run can never clobber a release.
 */
export function computeReleaseVersion(input: {
  expectedVersion: string;
  versionBump: VersionBump;
  tags: readonly string[];
  baseVersion: string;
}): ReleaseVersion {
  const previousTag = findLatestStableTag(input.tags);

  let version: string;
  if (input.expectedVersion.trim() !== "") {
    version = normalizeExpectedVersion(input.expectedVersion);
  } else if (previousTag !== "") {
    version = bumpVersion(previousTag.slice(1), input.versionBump);
  } else {
    const base = isStableSemver(input.baseVersion) ? input.baseVersion : "0.0.0";
    version = bumpVersion(base, input.versionBump);
  }

  const tagName = `v${version}`;
  if (input.tags.includes(tagName)) {
    throw new Error(`Tag ${tagName} already exists — pick a different version.`);
  }

  return { version, tagName, previousTag };
}

/**
 * Guards the idempotent publish: decides whether an already-published `name@version` may be
 * treated as *this* release's artifact.
 *
 * `compute-version` never picks a version whose tag exists, so npm can only be ahead of git when
 * an earlier run published and then failed before tagging (or someone published out of band).
 * Skipping the publish is right in the first case and wrong in the second: the release step would
 * go on to create `v${version}` at this run's commit, leaving the tag pointing at source the
 * published package does not contain.
 *
 * `gitHead` is the commit npm recorded at publish time, so it settles which case this is. An
 * absent one means the artifact was not published from a git checkout by this workflow, which is
 * exactly the case that needs a human. Without a `currentSha` (a local dry-run) there is nothing
 * to compare and the check stands down.
 */
export function assertPublishedFromCommit(input: {
  packageSpec: string;
  publishedGitHead: string;
  currentSha: string;
}): void {
  if (input.currentSha === "") return;
  if (input.publishedGitHead === "") {
    throw new Error(
      `${input.packageSpec} already exists on npm but records no gitHead, so it cannot be matched `
      + `to ${input.currentSha}. Reconcile the release by hand: publish a new version, or delete `
      + "the tag/release expectation for this one.",
    );
  }
  if (input.publishedGitHead !== input.currentSha) {
    throw new Error(
      `${input.packageSpec} already exists on npm, published from ${input.publishedGitHead}, but `
      + `this run would tag ${input.currentSha}. Releasing would make the git tag identify source `
      + "the published package does not contain — bump to a new version instead.",
    );
  }
}
