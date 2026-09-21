# Contributing

Use Node 22.18+ and Pi 0.87.0+. Install development dependencies with
`npm ci --ignore-scripts` and run `npm test`, `npm run test:install` and
`npm run audit:package`. Tests must use synthetic inputs and isolated homes.
Never add account credentials, real authenticated HTML, raw session recordings
or personal machine configuration to fixtures.

Runtime source is TypeScript loaded directly by Pi. Keep all runtime dependencies
in `dependencies`; Pi-provided libraries belong in `peerDependencies`. There must
be no install/prepare lifecycle hooks. Keep the Pi resource manifest and package
file allowlist explicit. Do not bundle Pi itself.

The default branch is consumed by unpinned Git installs. Review changes and pass
CI before merging. Tag tested milestones and document breaking changes. A tag is
an optional pin, not the update mechanism for unpinned users.

Before publication, inspect `git ls-files`, run a secret scanner across the full
history, inspect `npm pack --dry-run --json`, and inspect the actual archive.
Review licenses and third-party notices when copying or adding dependencies.
