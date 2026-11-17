import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  archiveUrl, dartInstallBinPath, dartPlatform, latestReleasePatch, parseSdk, parseSha256Sum, parseVersionMetadata,
  pubCachePath, releaseListingUrl, resolveArchitecture, resolveFlavor, sha256File
} from '../tasks/InstallDart/logic';

test('parses channels, releases, and exact versions like setup-dart', () => {
  assert.deepEqual(parseSdk(undefined), { kind: 'channel', channel: 'stable' });
  assert.deepEqual(parseSdk(' '), { kind: 'channel', channel: 'stable' });
  for (const channel of ['stable', 'beta', 'dev', 'main'] as const) {
    assert.deepEqual(parseSdk(channel), { kind: 'channel', channel });
  }
  assert.deepEqual(parseSdk('3.9'), { kind: 'release', release: '3.9' });
  assert.deepEqual(parseSdk('3'), { kind: 'release', release: '3.0' });
  assert.deepEqual(parseSdk('3.9.4'), { kind: 'version', version: '3.9.4', channel: 'stable' });
  assert.deepEqual(parseSdk('3.15.0-118.1.beta'), { kind: 'version', version: '3.15.0-118.1.beta', channel: 'beta' });
  assert.deepEqual(parseSdk('3.15.0-148.0.dev'), { kind: 'version', version: '3.15.0-148.0.dev', channel: 'dev' });
});

test('rejects unrecognized sdk values and main channel versions', () => {
  assert.throws(() => parseSdk('latest'), /Unrecognized sdk/);
  assert.throws(() => parseSdk('3.x'), /Unrecognized sdk/);
  assert.throws(() => parseSdk('../3.9.4'), /Unrecognized sdk/);
  assert.throws(() => parseSdk('3.15.0-1.0.main'), /main channel/);
});

test('defaults the flavor from the channel and validates explicit flavors', () => {
  assert.equal(resolveFlavor(undefined, parseSdk('stable')), 'release');
  assert.equal(resolveFlavor('auto', parseSdk('main')), 'raw');
  assert.equal(resolveFlavor('raw', parseSdk('dev')), 'raw');
  assert.throws(() => resolveFlavor('debug', parseSdk('stable')), /Unrecognized build flavor/);
  assert.throws(() => resolveFlavor('release', parseSdk('main')), /only has raw builds/);
});

test('maps the agent platform and architecture', () => {
  assert.equal(dartPlatform('win32'), 'windows');
  assert.equal(dartPlatform('darwin'), 'macos');
  assert.equal(dartPlatform('linux'), 'linux');
  assert.equal(resolveArchitecture('', 'arm64'), 'arm64');
  assert.equal(resolveArchitecture('auto', 'ppc64'), 'x64');
  assert.equal(resolveArchitecture('ia32', 'x64'), 'ia32');
  assert.throws(() => resolveArchitecture('mips', 'x64'), /Unrecognized architecture/);
});

test('builds archive URLs following dart.dev download URL layout', () => {
  assert.equal(
    archiveUrl('stable', 'release', '3.9.4', 'windows', 'x64'),
    'https://storage.googleapis.com/dart-archive/channels/stable/release/3.9.4/sdk/dartsdk-windows-x64-release.zip'
  );
  assert.equal(
    archiveUrl('main', 'raw', 'latest', 'macos', 'arm64'),
    'https://storage.googleapis.com/dart-archive/channels/main/raw/latest/sdk/dartsdk-macos-arm64-release.zip'
  );
  assert.equal(
    releaseListingUrl('3.9'),
    'https://storage.googleapis.com/storage/v1/b/dart-archive/o?prefix=channels%2Fstable%2Frelease%2F3.9.&delimiter=%2F'
  );
});

test('finds the highest stable patch numerically, ignoring other releases', () => {
  const listing = JSON.stringify({
    kind: 'storage#objects',
    prefixes: [
      'channels/stable/release/3.1.0/',
      'channels/stable/release/3.1.10/',
      'channels/stable/release/3.1.9/',
      'channels/stable/release/3.10.1/',
      'channels/stable/release/3.1.11-1.0.beta/'
    ]
  });
  assert.equal(latestReleasePatch(listing, '3.1'), '3.1.10');
  assert.throws(() => latestReleasePatch('{"kind":"storage#objects"}', '9.9'), /No stable Dart SDK release found for 9.9/);
});

test('reads the VERSION metadata file', () => {
  assert.equal(parseVersionMetadata('{"date":"2026-11-17","version":"3.14.1","revision":"c8a0db59"}'), '3.14.1');
  assert.throws(() => parseVersionMetadata('{"version":"../x"}'), /invalid VERSION/);
});

test('parses published checksum files for the expected archive only', () => {
  const hash = 'A27681BE873C3891692285DB8D656E7494CA80C74E86613B8085FC6CFFA3E31D';
  assert.equal(parseSha256Sum(`${hash} *dartsdk-linux-x64-release.zip\n`, 'dartsdk-linux-x64-release.zip'), hash.toLowerCase());
  assert.equal(parseSha256Sum(`${hash}  dartsdk-linux-x64-release.zip`, 'dartsdk-linux-x64-release.zip'), hash.toLowerCase());
  assert.throws(() => parseSha256Sum(`${hash} *dartsdk-linux-arm-release.zip`, 'dartsdk-linux-x64-release.zip'), /describes/);
  assert.throws(() => parseSha256Sum('<Error>NoSuchKey</Error>', 'dartsdk-linux-x64-release.zip'), /Invalid SHA-256/);
});

test('hashes files with SHA-256', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-dart-hash-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'archive.zip');
  const contents = crypto.randomBytes(300_000);
  fs.writeFileSync(file, contents);
  assert.equal(await sha256File(file), crypto.createHash('sha256').update(contents).digest('hex'));
});

test('locates the dart install bin directory like the Dart SDK', () => {
  assert.equal(dartInstallBinPath('windows', { LOCALAPPDATA: 'C:\\Users\\agent\\AppData\\Local', HOME: '/ignored' }),
    path.join('C:\\Users\\agent\\AppData\\Local', 'Dart', 'install', 'bin'));
  assert.equal(dartInstallBinPath('macos', { HOME: '/Users/agent', XDG_STATE_HOME: '/ignored' }),
    path.join('/Users/agent', 'Library', 'Application Support', 'Dart', 'install', 'bin'));
  assert.equal(dartInstallBinPath('linux', { HOME: '/home/agent' }), path.join('/home/agent', '.local', 'state', 'Dart', 'install', 'bin'));
  assert.equal(dartInstallBinPath('linux', { HOME: '/home/agent', XDG_STATE_HOME: '/xdg/state' }), path.join('/xdg/state', 'Dart', 'install', 'bin'));
  assert.equal(dartInstallBinPath('linux', { HOME: '/home/agent', XDG_STATE_HOME: '' }), path.join('/home/agent', '.local', 'state', 'Dart', 'install', 'bin'));
  for (const platform of ['windows', 'macos', 'linux'] as const) {
    assert.equal(dartInstallBinPath(platform, { DART_DATA_HOME: '/data/dart' }), path.join('/data/dart', 'install', 'bin'));
  }
  assert.throws(() => dartInstallBinPath('windows', {}), /LOCALAPPDATA is not set/);
  assert.throws(() => dartInstallBinPath('macos', {}), /HOME is not set/);
});

test('uses ~/.pub-cache on every platform', () => {
  assert.equal(pubCachePath('windows', { USERPROFILE: 'C:\\Users\\agent' }), path.join('C:\\Users\\agent', '.pub-cache'));
  assert.equal(pubCachePath('linux', { HOME: '/home/agent' }), path.join('/home/agent', '.pub-cache'));
  assert.throws(() => pubCachePath('macos', {}), /HOME is not set/);
});
