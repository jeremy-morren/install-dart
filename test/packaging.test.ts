import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { buildVersion, nextReleaseVersion, parseVersionLine } from '../scripts/version.mts';
import { normalizeLineEndings } from '../scripts/repack-vsix';

const line = { major: 1, minor: 2 };

test('package.json carries only the manually bumped major.minor line', () => {
  assert.deepEqual(parseVersionLine('1.2'), line);
  assert.deepEqual(parseVersionLine('10.0'), { major: 10, minor: 0 });
  for (const invalid of ['1.2.0', '1', '01.2', 'v1.2', 1.2, undefined]) {
    assert.throws(() => parseVersionLine(invalid), /must be major.minor/);
  }
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  parseVersionLine(version);
});

test('the first release of a line is patch 0, then one above the highest published release or tag', () => {
  assert.equal(nextReleaseVersion(line, []), '1.2.0');
  assert.equal(nextReleaseVersion(line, [{ tag_name: 'v1.2.0', draft: true }]), '1.2.0');
  assert.equal(nextReleaseVersion(line, [{ tag_name: 'v1.2.0', draft: false }]), '1.2.1');
  assert.equal(nextReleaseVersion(line, [
    { tag_name: 'v1.2.3', draft: false },
    { tag_name: 'v1.2.9', draft: true },
    { tag_name: 'v1.3.99', draft: false },
    { tag_name: 'v2.2.50', draft: false },
    { tag_name: 'v1.2.20-beta', draft: false },
    { tag_name: 'v1.2.1', draft: false }
  ]), '1.2.4');
  // An immutable release's tag stays reserved even after the release is deleted.
  assert.equal(nextReleaseVersion(line, [{ tag_name: 'v1.2.3', draft: false }], [{ name: 'v1.2.7' }, { name: 'other' }]), '1.2.8');
});

test('CI builds must use the allocated release version; local builds use patch 0', () => {
  assert.equal(buildVersion(line, {}), '1.2.0');
  assert.equal(buildVersion(line, { CI: 'false' }), '1.2.0');
  assert.throws(() => buildVersion(line, { CI: 'true' }), /RELEASE_VERSION is not set/);
  assert.throws(() => buildVersion(line, { GITHUB_ACTIONS: 'true' }), /RELEASE_VERSION is not set/);
  assert.equal(buildVersion(line, { GITHUB_ACTIONS: 'true', RELEASE_VERSION: '1.2.5' }), '1.2.5');
  assert.throws(() => buildVersion(line, { RELEASE_VERSION: '1.3.0' }), /not in the package.json version line 1.2/);
  assert.throws(() => buildVersion(line, { RELEASE_VERSION: 'v1.2.0' }), /must be major.minor.patch/);
});

test('release:version fetches releases and tags with gh and exports RELEASE_VERSION', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.2' }));
  const mockGh = path.join(directory, 'mock-gh.cjs');
  fs.writeFileSync(mockGh, `
    const assert = require('node:assert/strict');
    require('node:child_process').execFileSync = (command, args) => {
      assert.equal(command, 'gh');
      if (process.env.MOCK_GH_FAILURE) throw new Error('GitHub CLI authentication failed');
      if (args.at(-1) === 'repos/{owner}/{repo}/releases?per_page=100') return JSON.stringify([[{ tag_name: 'v1.2.0', draft: false }], [{ tag_name: 'v1.2.1', draft: true }]]);
      if (args.at(-1) === 'repos/{owner}/{repo}/tags?per_page=100') return JSON.stringify([[{ name: 'v1.2.0' }, { name: 'v1.2.1' }]]);
      throw new Error('unexpected gh call ' + args.join(' '));
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const script = path.resolve('scripts/release-version.mts');
  const githubEnv = path.join(directory, 'github.env');
  const stdout = execFileSync(process.execPath, ['--require', mockGh, script], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ENV: githubEnv }
  });
  assert.equal(stdout.trim(), '1.2.2');
  assert.equal(fs.readFileSync(githubEnv, 'utf8'), 'RELEASE_VERSION=1.2.2\n');

  const failure = spawnSync(process.execPath, ['--require', mockGh, script], {
    cwd: directory, encoding: 'utf8', env: { ...process.env, MOCK_GH_FAILURE: 'true', GITHUB_ENV: githubEnv }
  });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /GitHub CLI authentication failed/);
  assert.equal(fs.readFileSync(githubEnv, 'utf8'), 'RELEASE_VERSION=1.2.2\n');
});

test('the staged extension stamps one version into both manifests and contains only runtime files', () => {
  const staged = 'build/extension';
  const extension = JSON.parse(fs.readFileSync(`${staged}/vss-extension.json`, 'utf8'));
  const task = JSON.parse(fs.readFileSync(`${staged}/tasks/InstallDart/task.json`, 'utf8'));
  const { major, minor } = parseVersionLine(JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
  assert.match(extension.version, new RegExp(`^${major}\\.${minor}\\.\\d+$`));
  assert.equal(`${task.version.Major}.${task.version.Minor}.${task.version.Patch}`, extension.version);
  assert.equal(JSON.parse(fs.readFileSync('vss-extension.json', 'utf8')).version, undefined);
  assert.equal(JSON.parse(fs.readFileSync('tasks/InstallDart/task.json', 'utf8')).version, undefined);

  const files = (fs.readdirSync(staged, { recursive: true }) as string[])
    .map(file => file.split(path.sep).join('/'))
    .filter(file => fs.statSync(path.join(staged, file)).isFile())
    .sort();
  assert.deepEqual(files, [
    'LICENSE.txt',
    'docs/Overview.md',
    'images/logo.png',
    'tasks/InstallDart/dist/index.js',
    'tasks/InstallDart/icon.png',
    'tasks/InstallDart/task.json',
    'vss-extension.json'
  ]);
});

test('tfx-generated manifests are normalized to LF so Windows and Linux packages match', () => {
  const crlf = Buffer.from('<?xml version="1.0"?>\r\n<Types>\r\n</Types>');
  assert.equal(normalizeLineEndings('extension.vsixmanifest', crlf).toString(), '<?xml version="1.0"?>\n<Types>\n</Types>');
  assert.equal(normalizeLineEndings('[Content_Types].xml', crlf).toString(), '<?xml version="1.0"?>\n<Types>\n</Types>');
  assert.equal(normalizeLineEndings('extension.vsomanifest', Buffer.from('{\r\n}')).toString(), '{\n}');
  // Packaged content is left byte-for-byte as staged.
  assert.equal(normalizeLineEndings('docs/Overview.md', crlf), crlf);
});

test('repacking compresses and is identical across differently built archives and repeat runs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-repeat-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const text = Buffer.from('compressible example text\n'.repeat(1000));
  const manifest = Buffer.from('<?xml version="1.0"?>\r\n<PackageManifest />\r\n');
  // Same contents, but different entry order, timestamps, and compression.
  const inputs: Zippable[] = [
    { 'folder/': new Uint8Array(0), 'folder/example.txt': text, 'extension.vsixmanifest': manifest },
    { 'extension.vsixmanifest': [manifest, { level: 0 }], 'folder/example.txt': [text, { level: 1, mtime: new Date(2020, 5, 1) }], 'folder/': new Uint8Array(0) }
  ];
  const results = inputs.map((files, index) => {
    const file = path.join(directory, `${index}.vsix`);
    fs.writeFileSync(file, zipSync(files));
    execFileSync(process.execPath, [path.resolve('build/scripts/repack-vsix.js'), file, file]);
    const first = fs.readFileSync(file);
    execFileSync(process.execPath, [path.resolve('build/scripts/repack-vsix.js'), file, file]);
    assert.deepEqual(fs.readFileSync(file), first);
    return first;
  });
  assert.deepEqual(results[0], results[1]);
  assert.ok(results[0].length < text.length / 10, `expected compressed output, got ${results[0].length} bytes`);
  const repacked = unzipSync(results[0]);
  assert.deepEqual(Object.keys(repacked), ['extension.vsixmanifest', 'folder/', 'folder/example.txt']);
  assert.deepEqual(Buffer.from(repacked['folder/example.txt']), text);
  assert.equal(Buffer.from(repacked['extension.vsixmanifest']).toString(), '<?xml version="1.0"?>\n<PackageManifest />\n');
});
