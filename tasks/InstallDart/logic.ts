import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Root of the Dart SDK archive; see https://dart.dev/get-dart/archive#download-urls. */
export const ARCHIVE_ROOT = 'https://storage.googleapis.com/dart-archive';

export const ARCHITECTURES = ['x64', 'ia32', 'arm', 'arm64'] as const;
export type Architecture = typeof ARCHITECTURES[number];
export type DartPlatform = 'windows' | 'macos' | 'linux';
export type Channel = 'stable' | 'beta' | 'dev' | 'main';
export type Flavor = 'release' | 'raw';

export type SdkRequest =
  /** The latest build in a channel. */
  | { kind: 'channel'; channel: Channel }
  /** The latest stable patch of a major.minor SDK release. */
  | { kind: 'release'; release: string }
  /** An exact SDK version; its channel is derived from the version string. */
  | { kind: 'version'; version: string; channel: Exclude<Channel, 'main'> };

const RELEASE = /^\d+\.\d+$/;
// Dart SDK versions are semver, e.g. 3.9.4, 3.10.0-290.1.beta, 3.11.0-12.0.dev.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSdk(input: string | undefined): SdkRequest {
  let sdk = (input ?? '').trim() || 'stable';
  // A YAML `3.0` can reach a task as `3`; promote a bare integer back to major.minor (as setup-dart does).
  if (/^\d+$/.test(sdk)) sdk = `${sdk}.0`;

  if (sdk === 'stable' || sdk === 'beta' || sdk === 'dev' || sdk === 'main') {
    return { kind: 'channel', channel: sdk };
  }
  if (RELEASE.test(sdk)) {
    return { kind: 'release', release: sdk };
  }
  if (!VERSION.test(sdk)) {
    throw new Error(`Unrecognized sdk '${sdk}': use a channel (stable, beta, dev, main), a release (3.9), or a version (3.9.4).`);
  }
  if (sdk.includes('main')) {
    throw new Error('Versions cannot be specified for main channel builds.');
  }
  const channel = sdk.includes('dev') ? 'dev' : sdk.includes('beta') ? 'beta' : 'stable';
  return { kind: 'version', version: sdk, channel };
}

export function resolveFlavor(input: string | undefined, request: SdkRequest): Flavor {
  const flavor = (input ?? '').trim() || 'auto';
  const isMain = request.kind === 'channel' && request.channel === 'main';
  if (flavor === 'auto') return isMain ? 'raw' : 'release';
  if (flavor !== 'release' && flavor !== 'raw') {
    throw new Error(`Unrecognized build flavor '${flavor}': use release or raw.`);
  }
  if (isMain && flavor === 'release') {
    throw new Error("The main channel only has raw builds: use flavor 'raw' (or 'auto').");
  }
  return flavor;
}

export function dartPlatform(platform: NodeJS.Platform): DartPlatform {
  switch (platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'macos';
    default: return 'linux';
  }
}

/** An explicit architecture, or the agent's when one is not given (x64 if the agent's is not a Dart architecture). */
export function resolveArchitecture(input: string | undefined, agentArch: string): Architecture {
  const value = (input ?? '').trim();
  if (!value || value === 'auto') {
    return (ARCHITECTURES as readonly string[]).includes(agentArch) ? agentArch as Architecture : 'x64';
  }
  if (!(ARCHITECTURES as readonly string[]).includes(value)) {
    throw new Error(`Unrecognized architecture '${value}': use ${ARCHITECTURES.join(', ')}.`);
  }
  return value as Architecture;
}

/** The URL of a channel's `latest/VERSION` metadata. */
export function latestVersionUrl(channel: Channel, flavor: Flavor): string {
  return `${ARCHIVE_ROOT}/channels/${channel}/${flavor}/latest/VERSION`;
}

/** Parses `{"date": "...", "version": "3.9.4", "revision": "..."}`. */
export function parseVersionMetadata(json: string): string {
  const version = (JSON.parse(json) as { version?: unknown }).version;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`The Dart archive returned an invalid VERSION file: ${json}`);
  }
  return version;
}

/** The Cloud Storage listing of the stable patch releases for a major.minor release. */
export function releaseListingUrl(release: string): string {
  const prefix = encodeURIComponent(`channels/stable/release/${release}.`);
  return `https://storage.googleapis.com/storage/v1/b/dart-archive/o?prefix=${prefix}&delimiter=%2F`;
}

/** Finds the highest stable patch in a listing such as `{"prefixes": ["channels/stable/release/3.9.0/", ...]}`. */
export function latestReleasePatch(json: string, release: string): string {
  const prefixes = (JSON.parse(json) as { prefixes?: unknown }).prefixes;
  const [major, minor] = release.split('.').map(Number);
  let best: number[] | undefined;
  for (const prefix of Array.isArray(prefixes) ? prefixes : []) {
    if (typeof prefix !== 'string') continue;
    const match = STABLE_VERSION.exec(prefix.split('/').filter(Boolean).pop() ?? '');
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    if (parts[0] !== major || parts[1] !== minor) continue;
    if (!best || parts[2] > best[2]) best = parts;
  }
  if (!best) {
    throw new Error(`No stable Dart SDK release found for ${release}.`);
  }
  return best.join('.');
}

export function archiveFileName(platform: DartPlatform, arch: Architecture): string {
  return `dartsdk-${platform}-${arch}-release.zip`;
}

export function archiveUrl(channel: Channel, flavor: Flavor, version: string, platform: DartPlatform, arch: Architecture): string {
  return `${ARCHIVE_ROOT}/channels/${channel}/${flavor}/${version}/sdk/${archiveFileName(platform, arch)}`;
}

/** Parses a published `<hash> *<file>` checksum line, checking that it describes the expected file. */
export function parseSha256Sum(contents: string, fileName: string): string {
  const match = /^([0-9a-fA-F]{64}) [ *]?(\S+)\s*$/m.exec(contents);
  if (!match) {
    throw new Error(`Invalid SHA-256 checksum file for ${fileName}.`);
  }
  if (match[2] !== fileName) {
    throw new Error(`The SHA-256 checksum file describes ${match[2]}, not ${fileName}.`);
  }
  return match[1].toLowerCase();
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** setup-dart's pub cache: ~/.pub-cache on every platform. */
export function pubCachePath(platform: DartPlatform, env: NodeJS.ProcessEnv): string {
  const home = platform === 'windows' ? env.USERPROFILE : env.HOME;
  if (!home) {
    throw new Error(`${platform === 'windows' ? 'USERPROFILE' : 'HOME'} is not set; cannot locate the pub cache.`);
  }
  return path.join(home, '.pub-cache');
}

/**
 * Where `dart install` (Dart 3.10+) puts executables: `<Dart data home>/install/bin`, mirroring the SDK's
 * `getDartDataHome` (pkg/dart_data_home) and cli_util's `BaseDirectories('Dart').stateHome`.
 * Empty variables are treated as unset.
 */
export function dartInstallBinPath(platform: DartPlatform, env: NodeJS.ProcessEnv): string {
  const require = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set; cannot locate the dart install directory.`);
    return value;
  };
  let dataHome = env.DART_DATA_HOME;
  if (!dataHome) {
    switch (platform) {
      case 'windows':
        dataHome = path.join(require('LOCALAPPDATA'), 'Dart');
        break;
      case 'macos':
        dataHome = path.join(require('HOME'), 'Library', 'Application Support', 'Dart');
        break;
      case 'linux':
        dataHome = path.join(env.XDG_STATE_HOME || path.join(require('HOME'), '.local', 'state'), 'Dart');
        break;
    }
  }
  return path.join(dataHome, 'install', 'bin');
}
