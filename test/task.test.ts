import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const bundle = path.resolve('tasks/InstallDart/dist/index.js');
const e2e = process.env.INSTALL_DART_E2E === 'true';

function runTask(directory: string, inputs: Record<string, string>) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(INPUT_|AGENT_|DART_HOME$|PUB_CACHE$|DART_DATA_HOME$|XDG_STATE_HOME$)/i.test(key)) delete env[key];
  }
  // Keep everything the task writes (pub cache, dart install directory) inside the test directory.
  const home = path.join(directory, 'home');
  const localAppData = path.join(directory, 'localappdata');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(directory, 'temp'), { recursive: true });
  const result = spawnSync(process.execPath, [bundle], {
    encoding: 'utf8',
    env: {
      ...env,
      AGENT_VERSION: '4.264.2',
      AGENT_TEMPDIRECTORY: path.join(directory, 'temp'),
      AGENT_TOOLSDIRECTORY: path.join(directory, 'tools'),
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: localAppData,
      ...inputs
    }
  });
  return { ...result, output: result.stdout + result.stderr, home, localAppData };
}

/** The `dart install` bin directory the Dart SDK uses by default on this platform. */
function expectedInstallBin(home: string, localAppData: string): string {
  switch (process.platform) {
    case 'win32': return path.join(localAppData, 'Dart', 'install', 'bin');
    case 'darwin': return path.join(home, 'Library', 'Application Support', 'Dart', 'install', 'bin');
    default: return path.join(home, '.local', 'state', 'Dart', 'install', 'bin');
  }
}

function assertNoLocalizationWarnings(output: string): void {
  assert.doesNotMatch(output, /loc string|Resource file|LIB_|TOOL_LIB_/);
}

test('bundled task reports readable input errors', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-dart-input-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [inputs, message] of [
    [{ INPUT_SDK: 'latest' }, /Unrecognized sdk 'latest'/],
    [{ INPUT_SDK: 'main', INPUT_FLAVOR: 'release' }, /only has raw builds/],
    [{ INPUT_ARCHITECTURE: 'mips' }, /Unrecognized architecture 'mips'/]
  ] as const) {
    const result = runTask(directory, inputs);
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /task.complete result=Failed/);
    assert.match(result.stdout, message);
    assertNoLocalizationWarnings(result.output);
  }
});

test('installs a release, then reuses the tool cache for its exact version', { skip: !e2e && 'set INSTALL_DART_E2E=true (downloads the Dart SDK)', timeout: 15 * 60_000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'install-dart-e2e-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = runTask(directory, { INPUT_SDK: '3.9', INPUT_FLAVOR: 'auto', INPUT_ARCHITECTURE: 'auto' });
  assert.equal(first.status, 0, first.output);
  assert.match(first.stdout, /task.complete result=Succeeded/, first.output);
  assert.match(first.stdout, /Installing the \w+-\w+ Dart SDK version 3\.9\.4 from the stable \(release\) channel\./);
  assert.match(first.stdout, /SHA-256 [0-9a-f]{64} matches the published checksum\./);
  assert.match(first.output, /Dart SDK version: 3\.9\.4 \(stable\)/);
  assertNoLocalizationWarnings(first.output);

  const arch = ['x64', 'ia32', 'arm', 'arm64'].includes(os.arch()) ? os.arch() : 'x64';
  const sdk = path.join(directory, 'tools', 'dart', '3.9.4', arch);
  const pubCache = path.join(first.home, '.pub-cache');
  const lines = first.stdout.split(/\r?\n/);
  assert.ok(lines.includes(`##vso[task.setvariable variable=DART_HOME;isOutput=false;issecret=false;]${sdk}`), first.stdout);
  assert.ok(lines.includes(`##vso[task.setvariable variable=PUB_CACHE;isOutput=false;issecret=false;]${pubCache}`), first.stdout);
  assert.ok(lines.includes('##vso[task.setvariable variable=dartVersion;isOutput=true;issecret=false;]3.9.4'), first.stdout);
  // Prepended in this order, so dart install and then pub global executables take precedence over the SDK.
  const installBin = expectedInstallBin(first.home, first.localAppData);
  const prepended = lines.filter(line => line.startsWith('##vso[task.prependpath]'));
  assert.deepEqual(prepended, [
    `##vso[task.prependpath]${path.join(sdk, 'bin')}`,
    `##vso[task.prependpath]${path.join(pubCache, 'bin')}`,
    `##vso[task.prependpath]${installBin}`
  ]);
  assert.ok(fs.statSync(installBin).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(directory, 'temp')).filter(name => name.endsWith('.zip')), []);

  const second = runTask(directory, { INPUT_SDK: '3.9.4' });
  assert.match(second.stdout, /task.complete result=Succeeded/, second.output);
  assert.match(second.stdout, /Using cached SDK from /);
  assert.doesNotMatch(second.stdout, /dartsdk-.*\.zip \.\.\./);
  assert.match(second.output, /Dart SDK version: 3\.9\.4 \(stable\)/);
});
