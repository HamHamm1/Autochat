# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is
[SemVer](https://semver.org/).

## [1.0.0] — Initial release

### Added
- **Autonomous token watcher** with debounced recounting, rolling growth
  average, and threshold edge-detection (fires once per crossing).
- **Atomic rollover engine**: summarize → validate → commit. The live chat is
  never mutated unless a valid summary is produced.
- **Summarization profiles** with a modular registry:
  - `OC Canon Compact` (≤2000 tokens, default trigger 145k).
  - `Anime Story Summary v17` — five-phase canonical ledger with re-emitted
    `<CANON_STATE>`, MODE A/B, event-seal count, anti-retcon repair
    (default trigger 140k).
  - `Custom Template` — editable prompt with `{{character}}`, `{{lore}}`,
    `{{history}}`, `{{recent}}`, `{{maxTokens}}` placeholders; save / load /
    duplicate / rename / import / export.
- **Profile scoping**: Character override → Chat override → Global default,
  persisted in `extension_settings`.
- **Settings panel** in the Extensions menu plus an inline **top-bar quick
  switch**; profile-description panel and a non-intrusive anime-profile
  suggestion.
- **Continuity reseed**: the latest `{{char}}` message is preserved as the first
  retained assistant turn, de-duplicated to avoid repeated dialogue.
- **Canonical memory injection** via `setExtensionPrompt` (safe, reversible);
  optional opt-in literal Main Prompt overwrite where supported.
- **Safety systems**: one-click rollback buffer, corruption/structure/token-cap
  validation with one retry then fallback to OC Canon Compact, configurable
  cooldown (default 120s), re-entrancy guard.
- **Modes**: Silent / Notify / Confirm / Debug.
- **Snapshots**: export / import / clear; optional archiving of trimmed
  messages; capped ring buffer to keep the settings file small.
- **Dry-run preview** ("Test Selected Profile") rendered in a modal.
- **Slash commands**: `/acr-rollover`, `/acr-rollback`, `/acr-recount`,
  `/acr-test`.

### Notes
- World-info / lorebook extraction is best-effort and version-dependent; the
  extension degrades to empty rather than guessing.
- Requires `generateQuietPrompt` for automatic rollover; reports clearly when
  unavailable.
