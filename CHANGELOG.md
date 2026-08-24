# Changelog

All notable changes to DomLingo will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/). During the initial Alpha phase,
interfaces and stored data formats may still change.

## [Unreleased]

### Added

- A single “DomLingo: AI translate current page” context-menu action that reuses the existing translation flow and opens Settings when configuration is missing.

### Changed

- Completed semantic blocks now write back immediately instead of waiting for earlier concurrent batches, while split paragraphs, list items, and table rows remain atomic.

## [0.1.0-alpha.0] - 2026-08-08

### Added

- Product requirements, technical design, and development roadmap.
- GitHub Flow contribution rules and Pull Request/Issue templates.
- Initial WXT, React, TypeScript, testing, and build foundation.
- Initial Provider presets, endpoint validation, runtime permissions, and connection-test UI.
- Device-encrypted local API key persistence with trusted session recovery.
- Granted API origin management and permission revocation in Options.
- Provider, permission, credential encryption, and Ollama-compatible fixture coverage.
- Initial static-page main-content detection, safe source collection, translation, and restore flow.
- Popup controls for on-demand translation, progress polling, stopping, and original-text recovery.
- Closed-Shadow-DOM page progress overlay with stop and restore controls.
- Long-node splitting, time-sliced source collection, partial-failure handling, and cancellation guards.
- Documentation utility-control exclusion and inline-code-aware translation context.
- Segment-count batch limits, transient provider retries, and categorized node failure reporting.
- Ordered DOM commits for concurrent batches, fenced-JSON normalization, and one automatic response-format repair.
- Retry-failed controls in the Popup and page overlay that preserve successful translations.
- Per-endpoint structured-output capability probing with JSON Schema, JSON Mode, and Prompt fallbacks.
- Dynamic output-token budgets, truncation classification, and bounded adaptive splitting for malformed batches.
- A saved 1–3 request concurrency control for provider compatibility testing.
- Conservative 2,000-character/10-segment batches with extra completion-token reserve.
- Atomic semantic-block DOM commits for paragraphs, list items, and table rows, including cached partial results across failed-node retries.
- Automatic request cancellation on tab close, reload, cross-document navigation, pagehide, and SPA route invalidation without adding broad tab permissions.
- Time-sliced main-content scoring and source collection with 5,000-node responsiveness regression coverage.

[Unreleased]: https://github.com/FLF-Gamer/DomLingo/compare/v0.1.0-alpha.0...HEAD
[0.1.0-alpha.0]: https://github.com/FLF-Gamer/DomLingo/releases/tag/v0.1.0-alpha.0
