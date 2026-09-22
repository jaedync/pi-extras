# Changelog

Versioning rules are in [CONTRIBUTING.md](CONTRIBUTING.md#versioning).

## 0.2.1 - 2026-09-22

### Fixed

- Phase Spinner shows Pi's compaction, retry and branch-summary statuses in
  the editor border again. They were hidden because the spinner embeds Pi's
  status indicators but only drew its own phases. Each status gets its own
  spinner and an event timer; a retry keeps one timer across attempts, and the
  retried request shows its live phase with `retry n/m`.

## 0.2.0 - 2026-09-22

### Added

- Usage Guard extension: `usage` tool, `/usage` command, session budgets
  ("work until 60% of the weekly limit") and optional one-shot wrap-up
  warnings near a limit. Band warnings are off by default.

### Changed

- Status Plus shares its limit snapshots with Usage Guard, polls a provider
  faster near a threshold, backs off exponentially on failures, and reads
  model-scoped windows such as `seven_day_fable`.

### Fixed

- Usage Guard sends at most one wrap-up per window and reset cycle, even when
  a proxy recomputes the reset time on every fetch.
- Per-minute rate limits from response headers never trigger warnings.

## 0.1.0

- Initial release: Status Plus, Phase Spinner, Shell Jobs, Bash Default
  Timeout, Kagi Search and the Quiet theme.
