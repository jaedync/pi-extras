# Contributing

Use Node 22.18+ and Pi 0.87.0+. Install development dependencies with
`npm ci --ignore-scripts` and run `npm run typecheck`, `npm test`,
`npm run test:install` and `npm run audit:package`. Tests must use synthetic inputs and isolated homes.
Never add account credentials, real authenticated HTML, raw session recordings
or personal machine configuration to fixtures.

Runtime source is TypeScript loaded directly by Pi. Keep all runtime dependencies
in `dependencies`; Pi-provided libraries belong in `peerDependencies`. There must
be no install/prepare lifecycle hooks. Keep the Pi resource manifest and package
file allowlist explicit. Do not bundle Pi itself.

The default branch is consumed by unpinned Git installs. Review changes and pass
CI before merging. A tag is an optional pin, not the update mechanism for
unpinned users.

## Versioning

Bump once per push batch; the largest change in the batch decides.

- Minor (`0.1.0` to `0.2.0`): an extension added or removed, or a breaking
  change to an existing one (a removed or renamed tool, command or config key,
  or a changed default that users rely on).
- Patch (`0.2.0` to `0.2.1`): a fix or compatible change to how an existing
  extension works.
- None: docs, tests, CI or tooling only.

## Definition of done

A change that ships to `main` is done when:

1. `npm run typecheck`, `npm test`, `npm run test:install` and
   `npm run audit:package` pass.
2. `package.json` and `package-lock.json` carry the bumped version, and
   `CHANGELOG.md` has a matching top entry (a contract test enforces this).
3. README and `docs/` describe any new or changed behavior and config.
4. The release commit is tagged `vX.Y.Z` and pushed together with the tag.
5. The running Pi has reloaded the pushed commit and the change was checked
   live.
6. For a minor or major release, the preview image is re-rendered from the
   release candidate (`npm run preview:render`) and reviewed: the title, voice
   row, jobs and footer are legible in the 4:3 crop and at README width
   (`npm run preview:check -- --open`), and nothing personal is on screen.
   Commit the WebP and `meta.json` with the release, and upload the rendered
   `.github/preview/pi-extras.png` (ignored by git) under the repository's
   Settings > General > Social preview. A contract test fails until the
   committed image was rendered for the current minor version.

Before publication, inspect `git ls-files`, run a secret scanner across the full
history, inspect `npm pack --dry-run --json`, and inspect the actual archive.
Review licenses and third-party notices when copying or adding dependencies.
