import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import tl = require('azure-pipelines-task-lib/task');
import toolLib = require('azure-pipelines-tool-lib/tool');
import { HttpClient } from 'typed-rest-client/HttpClient';
import {
  Architecture, Channel, DartPlatform, Flavor, SdkRequest,
  archiveFileName, archiveUrl, dartInstallBinPath, dartPlatform, latestReleasePatch, latestVersionUrl, parseSdk, parseSha256Sum,
  parseVersionMetadata, pubCachePath, releaseListingUrl, resolveArchitecture, resolveFlavor, sha256File
} from './logic';

const TOOL_NAME = 'dart';

/** GETs a small text resource through the agent's proxy and certificate configuration. */
async function getText(url: string): Promise<string> {
  const client = new HttpClient('install-dart-task', undefined, {
    proxy: tl.getHttpProxyConfiguration(url) ?? undefined,
    cert: tl.getHttpCertConfiguration() ?? undefined,
    allowRedirects: true,
    allowRetries: true,
    maxRetries: 3
  });
  const response = await client.get(url);
  const body = await response.readBody();
  if (response.message.statusCode !== 200) {
    throw new Error(`GET ${url} failed with HTTP ${response.message.statusCode}.`);
  }
  return body;
}

async function resolveVersion(request: SdkRequest, flavor: Flavor): Promise<{ channel: Channel; version: string }> {
  switch (request.kind) {
    case 'release':
      return { channel: 'stable', version: latestReleasePatch(await getText(releaseListingUrl(request.release)), request.release) };
    case 'channel':
      // Raw builds are only addressable as 'latest'; published builds resolve to a concrete, cacheable version.
      return {
        channel: request.channel,
        version: flavor === 'raw' ? 'latest' : parseVersionMetadata(await getText(latestVersionUrl(request.channel, flavor)))
      };
    case 'version':
      return { channel: request.channel, version: request.version };
  }
}

/**
 * Extracts a zip into a new directory beside it. Outside Windows, tool-lib's extractZip runs `unzip` without `-q`,
 * which logs a line for every file in the SDK; on Windows it uses PowerShell, which is already quiet.
 */
async function extractZip(archive: string): Promise<string> {
  if (process.platform === 'win32') {
    return toolLib.extractZip(archive);
  }
  const destination = path.join(path.dirname(archive), randomUUID());
  tl.mkdirP(destination);
  await tl.tool('unzip').arg(['-q', archive]).execAsync({ cwd: destination });
  return destination;
}

/** Downloads, checks for corruption, and extracts the SDK; release builds are added to the agent tool cache. */
async function downloadSdk(url: string, platform: DartPlatform, arch: Architecture, cacheVersion?: string): Promise<string> {
  const fileName = archiveFileName(platform, arch);
  console.log(`${url} ...`);
  const archive = await toolLib.downloadToolWithRetries(url, `${randomUUID()}-${fileName}`);
  try {
    const expected = parseSha256Sum(await getText(`${url}.sha256sum`), fileName);
    const actual = await sha256File(archive);
    if (actual !== expected) {
      throw new Error(`SHA-256 mismatch for ${fileName}: expected ${expected}, downloaded ${actual}.`);
    }
    console.log(`Download is not corrupt: SHA-256 ${actual} matches the published hash.`);

    const sdkDirectory = path.join(await extractZip(archive), 'dart-sdk');
    if (!fs.existsSync(path.join(sdkDirectory, 'version'))) {
      throw new Error(`${fileName} does not contain a dart-sdk directory.`);
    }
    return cacheVersion ? await toolLib.cacheDir(sdkDirectory, TOOL_NAME, cacheVersion, arch) : sdkDirectory;
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function run(): Promise<void> {
  try {
    const request = parseSdk(tl.getInput('sdk', false));
    const flavor = resolveFlavor(tl.getInput('flavor', false), request);
    const platform = dartPlatform(process.platform);
    const arch = resolveArchitecture(tl.getInput('architecture', false), os.arch());
    const { channel, version } = await resolveVersion(request, flavor);

    console.log(`Installing the ${platform}-${arch} Dart SDK version ${version} from the ${channel} (${flavor}) channel.`);

    // Raw builds are unpublished and may be rebuilt, so they are never served from the cache.
    const cacheVersion = flavor === 'release' ? version : undefined;
    let sdkPath = cacheVersion ? toolLib.findLocalTool(TOOL_NAME, cacheVersion, arch) : undefined;
    if (sdkPath) {
      console.log(`Using cached SDK from ${sdkPath}.`);
    } else {
      sdkPath = await downloadSdk(archiveUrl(channel, flavor, version, platform, arch), platform, arch, cacheVersion);
    }

    const pubCache = pubCachePath(platform, process.env);
    const installBin = dartInstallBinPath(platform, process.env);
    // prependPath requires existing directories; dart creates the rest of these on demand.
    tl.mkdirP(path.join(pubCache, 'bin'));
    tl.mkdirP(installBin);

    // Each prepend takes precedence over the previous one: dart install, then pub global, then the SDK.
    tl.setVariable('DART_HOME', sdkPath);
    toolLib.prependPath(path.join(sdkPath, 'bin'));
    tl.setVariable('PUB_CACHE', pubCache);
    toolLib.prependPath(path.join(pubCache, 'bin'));
    // Executables from `dart install` (Dart 3.10+). See https://github.com/dart-lang/setup-dart/issues/181.
    toolLib.prependPath(installBin);

    const installedVersion = fs.readFileSync(path.join(sdkPath, 'version'), 'utf8').trim();
    tl.setVariable('dartVersion', installedVersion, false, true);

    const dart = path.join(sdkPath, 'bin', platform === 'windows' ? 'dart.exe' : 'dart');
    await tl.tool(dart).arg('--version').execAsync();

    tl.setResult(tl.TaskResult.Succeeded, `Installed Dart SDK ${installedVersion}.`);
  } catch (error) {
    tl.setResult(tl.TaskResult.Failed, error instanceof Error ? error.message : String(error));
  }
}

void run();
