import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { nextReleaseVersion, readVersionLine } from './version.mts';

if (process.argv[2]) {
  throw new Error('Usage: npm run release:version (releases and tags are fetched with gh).');
}

/** gh resolves the repository from the checkout (or GH_REPO) and uses its login or the GH_TOKEN supplied by CI. */
function ghPaginated<T>(endpoint: string): T[] {
  return JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', endpoint], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024
    })
  ).flat();
}

const version = nextReleaseVersion(
  readVersionLine(),
  ghPaginated('repos/{owner}/{repo}/releases?per_page=100'),
  ghPaginated('repos/{owner}/{repo}/tags?per_page=100')
);

// In GitHub Actions, expose the version as the step output `version`; steps that build pass it on as RELEASE_VERSION.
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
console.log(version);
