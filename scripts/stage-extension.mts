import fs from 'node:fs';
import path from 'node:path';
import { buildVersion, readVersionLine } from './version.mts';

/**
 * Assembles build/extension, the only directory tfx packages. Versions are stamped
 * into copies of the manifests, so source manifests never carry (or change) a version.
 */
const STAGING_DIRECTORY = 'build/extension';
const TASK_DIRECTORY = 'tasks/InstallDart';

const version = buildVersion(readVersionLine());
const [major, minor, patch] = version.split('.').map(Number);

fs.rmSync(STAGING_DIRECTORY, { recursive: true, force: true });

function copy(source: string, destination = source): void {
  const target = path.join(STAGING_DIRECTORY, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function writeJson(destination: string, value: unknown): void {
  const target = path.join(STAGING_DIRECTORY, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

const extension = JSON.parse(fs.readFileSync('vss-extension.json', 'utf8'));
writeJson('vss-extension.json', { ...extension, version });

const task = JSON.parse(fs.readFileSync(`${TASK_DIRECTORY}/task.json`, 'utf8'));
// Insert the version after the identifying fields, where Azure DevOps tasks conventionally keep it.
const { inputs, outputVariables, execution, ...header } = task;
writeJson(`${TASK_DIRECTORY}/task.json`, {
  ...header,
  version: { Major: major, Minor: minor, Patch: patch },
  inputs,
  outputVariables,
  execution
});

copy(`${TASK_DIRECTORY}/icon.png`);
copy(`${TASK_DIRECTORY}/dist/index.js`);
copy('images/logo.png');
copy('docs/Overview.md');
copy('LICENSE.txt');

console.log(`Staged extension version ${version} in ${STAGING_DIRECTORY}.`);
