import fs from 'node:fs';

export interface Release {
  tag_name: string;
  draft: boolean;
}

export interface Tag {
  name: string;
}

export interface VersionLine {
  major: number;
  minor: number;
}

const VERSION_LINE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The manually bumped major.minor line, from the root package.json `version`. */
export function parseVersionLine(version: unknown): VersionLine {
  const match = typeof version === 'string' ? VERSION_LINE.exec(version) : null;
  if (!match) {
    throw new Error(`package.json version must be major.minor (for example "1.0"), not ${JSON.stringify(version)}.`);
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error('package.json major/minor is too large.');
  }
  return { major, minor };
}

export function readVersionLine(packageJsonPath = 'package.json'): VersionLine {
  return parseVersionLine(JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version);
}

/**
 * Allocates the next patch in a major.minor line: one above the highest published
 * release or existing tag, or patch 0 when nothing has been published in that line.
 * Drafts do not reserve versions. Tags are counted because immutable releases keep
 * their tag reserved even if the release is later deleted.
 */
export function nextReleaseVersion(line: VersionLine, releases: Release[], tags: Tag[] = []): string {
  const names = [
    ...releases.filter(release => !release.draft).map(release => release.tag_name),
    ...tags.map(tag => tag.name)
  ];
  let highest = -1;
  for (const name of names) {
    const match = RELEASE_TAG.exec(name);
    if (match && Number(match[1]) === line.major && Number(match[2]) === line.minor) {
      const patch = Number(match[3]);
      if (!Number.isSafeInteger(patch + 1)) throw new Error('Release patch is too large.');
      highest = Math.max(highest, patch);
    }
  }
  return `${line.major}.${line.minor}.${highest + 1}`;
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_ACTIONS === 'true' || Boolean(env.CI && env.CI !== 'false');
}

/**
 * The version stamped into the packaged task and extension manifests.
 * CI must supply RELEASE_VERSION (from `npm run release:version`), local builds use patch 0.
 */
export function buildVersion(line: VersionLine, env: NodeJS.ProcessEnv = process.env): string {
  const requested = env.RELEASE_VERSION;
  if (!requested) {
    if (isCi(env)) {
      throw new Error('RELEASE_VERSION is not set: run npm run release:version before building in CI.');
    }
    return `${line.major}.${line.minor}.0`;
  }
  const match = RELEASE_VERSION.exec(requested);
  if (!match || !Number.isSafeInteger(Number(match[3]))) {
    throw new Error(`RELEASE_VERSION must be major.minor.patch, not ${JSON.stringify(requested)}.`);
  }
  if (Number(match[1]) !== line.major || Number(match[2]) !== line.minor) {
    throw new Error(`RELEASE_VERSION ${requested} is not in the package.json version line ${line.major}.${line.minor}.`);
  }
  return requested;
}
