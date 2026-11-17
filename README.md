# Install Dart SDK for Azure Pipelines

[![GitHub repository](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](https://github.com/jeremy-morren/install-dart)
[![Build](https://img.shields.io/github/actions/workflow/status/jeremy-morren/install-dart/build.yml?label=Build)](https://github.com/jeremy-morren/install-dart/actions/workflows/build.yml)
[![Publish](https://img.shields.io/github/actions/workflow/status/jeremy-morren/install-dart/publish.yml?label=Publish)](https://github.com/jeremy-morren/install-dart/actions/workflows/publish.yml)

`InstallDart@1` downloads the Dart SDK and puts `dart` on the `PATH` for the rest of the job, on Windows, macOS, and Linux agents. It is a port of the [`dart-lang/setup-dart`](https://github.com/dart-lang/setup-dart) GitHub Action and installs the same SDK builds the same way. The task:

* downloads `dartsdk-<os>-<arch>-release.zip` from the [Dart SDK archive](https://dart.dev/get-dart/archive)
* checks the download for corruption against the SHA-256 hash published next to it in the archive
* caches release builds in the agent tool cache (`Agent.ToolsDirectory`), so later jobs on the same agent reuse them
* sets `DART_HOME` and `PUB_CACHE`, and adds `$(DART_HOME)/bin`, `$(PUB_CACHE)/bin`, and the `dart install` directory to the `PATH`

## Installation

Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jeremy-morren.installdart).

## Usage

```yaml
steps:
  - task: InstallDart@1

  - script: dart pub get
  - script: dart format --output=none --set-exit-if-changed .
  - script: dart analyze
  - script: dart test
```

Note: Linux and macOS agents need `unzip` to extract the SDK. Microsoft-hosted agents have it, self-hosted agents may need it installed.

## Inputs

| Input          | Default  | Description |
| -------------- | -------- | ----------- |
| `sdk`          | `stable` | A release channel (`stable`, `beta`, `dev`, or `main`) for its latest build; an SDK release such as `3.9` for its latest stable patch; or an exact version such as `3.9.4` or `3.15.0-118.1.beta`. |
| `flavor`       | `auto`   | `release` for published builds or `raw` for unpublished builds. `auto` uses `raw` for the `main` channel (its only flavor) and `release` otherwise. Raw builds are not cached. |
| `architecture` | `auto`   | `x64`, `ia32`, `arm`, or `arm64`. `auto` uses the agent's architecture. Not every architecture is available on every operating system; see the [Dart system requirements](https://dart.dev/get-dart#system-requirements). |

Quote versions in YAML, e.g. `sdk: '3.10'`, so they are not read as numbers (`3.10` would become `3.1`).

## Outputs

| Variable      | Description |
| ------------- | ----------- |
| `dartVersion` | The installed Dart SDK version, such as `3.9.4`. Give the step a `name` to read it as `$(<name>.dartVersion)`. |

The task also sets the `DART_HOME` and `PUB_CACHE` pipeline variables for later steps in the job.

## Caching pub packages

`PUB_CACHE` is `~/.pub-cache` (`%USERPROFILE%\.pub-cache` on Windows), so you can cache it with the `Cache@2` task:

```yaml
- task: InstallDart@1

- task: Cache@2
  inputs:
    key: 'pub | "$(Agent.OS)" | **/pubspec.lock'
    path: $(PUB_CACHE)

- script: dart pub get
```

## Differences from setup-dart

* **Corruption check**: the task checks each download for corruption against the SHA-256 hash in the `.sha256sum` file published next to it in the Dart archive. setup-dart does not. The hash comes from the same server as the download, so it detects damaged or truncated files, not deliberate tampering.
* **No problem matcher**: Azure Pipelines has no equivalent of GitHub problem matchers, so `dart analyze` output is not turned into annotations.
* **No pub.dev OIDC token**: pub.dev's automated publishing accepts GitHub Actions and Google Cloud identities only, so the task does not create a `PUB_TOKEN`.

## Matrix example

```yaml

jobs:

- job: Dart
  strategy:
    matrix:
      linux_stable: { image: ubuntu-latest, sdk: stable }
      mac_stable: { image: macos-latest, sdk: stable }
      windows_stable: { image: windows-latest, sdk: stable }
      linux_3_9: { image: ubuntu-latest, sdk: '3.9' }
      linux_beta: { image: ubuntu-latest, sdk: beta }
  pool:
    vmImage: $(image)
  steps:
    - task: InstallDart@1
      name: dart
      inputs:
        sdk: $(sdk)

    - script: echo "Testing with Dart $(dart.dartVersion)"
    - script: dart pub get
    - script: dart test
```

## License

[MIT](./LICENSE.txt). Dart and the Dart logo are trademarks of Google LLC. This extension is not affiliated with or endorsed by Google.
