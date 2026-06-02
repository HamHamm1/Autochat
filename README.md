# st-auto-context-rollover

Autonomous infinite-context roleplay for **SillyTavern**. This extension watches
your context token usage and, before you hit the model's limit, silently
compresses the conversation into a structured **canonical memory**, trims old
history, and reseeds continuity — so long RP sessions feel uninterrupted.

It ships with selectable **summarization profiles** (OC Canon Compact, Anime
Story Summary v17, and fully custom templates) and a complete safety system
(atomic rollovers, one-click rollback, corruption detection, cooldown).

---

## How it works (architecture)

```
index.js                 wiring + event subscriptions + slash commands
├─ lib/
│  ├─ tokenMonitor.js     debounced token recount + threshold edge detection
│  ├─ summarizer.js       context assembly + background generation
│  ├─ rolloverEngine.js   atomic pipeline: summarize → validate → commit
│  ├─ validators.js       corruption / structure / token-cap checks
│  └─ storage.js          extension_settings persistence (config/snapshots)
├─ ui/
│  ├─ settingsPanel.js    Extensions-menu panel + top-bar quick switch
│  └─ toast.js            toastr wrapper + modal/confirm helpers
└─ profiles/
   ├─ registry.js         modular profile registry
   ├─ ocCanonCompact.js   PROFILE 1
   ├─ animeStorySummaryV17.js  PROFILE 2
   └─ customTemplate.js   PROFILE 3 factory
```

### The rollover pipeline

1. **Token watcher.** After every context-changing event (`MESSAGE_RECEIVED`,
   `MESSAGE_SENT`, swipe, delete, edit, generation end) the monitor performs a
   debounced recount of the active chat plus character-card overhead, tracks a
   rolling growth average, and edge-detects threshold crossings (so it fires
   once per crossing, not on every recount).
2. **Auto trigger.** On crossing, the rollover engine runs — honoring the
   selected **mode** (silent / notify / confirm / debug) and a **cooldown**.
3. **Data extraction.** The summarizer assembles: character card
   (personality / scenario / description / example dialogue), active world-info
   entries (best-effort), the full older history, and a preserved recent window.
4. **Summarization.** The active profile builds its prompt; we run it through
   SillyTavern's own **background generation** (`generateQuietPrompt`) so no
   second API key is needed and nothing is posted to the visible chat.
5. **Validation (corruption detection).** Output must be non-empty, contain the
   profile's required headers, pass the profile's structural validator, and fit
   under its token cap. **Invalid → retry once → fall back to OC Canon Compact.**
6. **Atomic commit.** Only after a valid summary do we touch the live chat:
   snapshot current state → inject canonical memory → trim old history → reseed
   the latest `{{char}}` message for seamless continuation → persist.

### A note on "overwrite the Main Prompt"

The spec asks to overwrite the Main Prompt. Directly rewriting your preset's
Main Prompt is destructive and not reversible through SillyTavern's public APIs,
so by default this extension instead **injects** the canonical memory at the top
of context via `setExtensionPrompt` (depth 0, high priority) — the same
mechanism the built-in Summarize/Memory extension uses. This is functionally a
refreshed system memory and is fully reversible by rollback.

If you really want literal preset mutation, set `overwriteMainPrompt: true` in
the stored config; it is only honored when your ST build exposes a public
setter, and otherwise silently uses the safe injection path.

---

## Summarization profiles

| Profile | Best for | Token cap | Default trigger |
|---|---|---|---|
| **OC Canon Compact** | Original-character / sandbox RP | 2000 | 145,000 |
| **Anime Story Summary v17** | Anime / lore-heavy, canon-driven bots | 3500 | 140,000 |
| **Custom Template** | Your own prompt | configurable | configurable |

- **Scope priority:** Character override → Chat override → Global default.
- **Quick switch:** an inline selector in the chat top bar changes the profile
  for the current chat; it applies on the next rollover.
- **Suggestion (never auto-switch):** if a character looks anime/lore-heavy, the
  panel suggests v17 but never switches without your confirmation.
- **Anime v17 advanced options:** MODE A / MODE B toggles, autonomous snapshot
  threshold, event-seal trigger count, anti-retcon repair.

---

## Installation

### Option A — built-in installer (recommended)

1. In SillyTavern, open **Extensions → Install Extension**.
2. Paste this repository's Git URL and confirm.
3. Reload SillyTavern. Open **Extensions** and expand **Auto Context Rollover**.

### Option B — manual install

Copy the repository folder into your SillyTavern extensions directory:

```
SillyTavern/public/scripts/extensions/third-party/st-auto-context-rollover/
```

so that `manifest.json` sits at the root of that folder, then reload
SillyTavern. (See `INSTALL.md` for OS-specific paths.)

---

## Configuration guide

Open **Extensions → Auto Context Rollover**:

- **Enable Auto Rollover** — master on/off.
- **Summary Profile** + **Apply To** (Global / Chat / Character) — choose the
  profile and the scope it's saved at.
- **Trigger Threshold** (120k–190k) — when to roll over.
- **Summary Max Tokens** (500–4000) — soft cap target for the summary.
- **Retained Message Count** (4–50) — how many recent messages survive a trim.
- **Mode** — Silent / Notify / Confirm / Debug.
- **Cooldown** — minimum seconds between automatic rollovers.
- **Archive trimmed messages** — keep removed messages inside snapshots.

**Buttons:** Manual Trigger · Rollback Last · Test Selected Profile (dry-run
preview modal) · Export / Import / Clear Snapshots.

**Slash commands:** `/acr-rollover`, `/acr-rollback`, `/acr-recount`,
`/acr-test`.

---

## GitHub deployment

```bash
git init
git add .
git commit -m "feat: initial Auto Context Rollover extension"
git branch -M main
git remote add origin https://github.com/HamHamm1/Autochat.git
git push -u origin main
```

Users then install via the Git URL (Option A above).

---

## Troubleshooting

- **Nothing happens at the threshold.** Confirm the extension is enabled and you
  aren't inside the cooldown window. Switch Mode to **Debug** and watch the
  browser console for `[Auto-Context-Rollover]` recount logs.
- **"generateQuietPrompt is unavailable".** Your ST build is older than the
  background-generation API. Update SillyTavern.
- **Summary keeps failing validation.** Open the console in Debug mode to see
  the reason (missing header / too large). Custom profiles: make sure your
  "Required headers" actually appear in your template's instructions.
- **Lore isn't captured.** World-info access varies by ST version; the extension
  degrades to empty rather than guessing. The character card is always captured.
- **Want to undo a rollover.** Click **Rollback Last** (or `/acr-rollback`). The
  previous full chat is restored from the snapshot buffer.

---

## API assumptions

This extension targets the modern SillyTavern context API and degrades when a
surface is missing:

- `SillyTavern.getContext()` for `chat`, `characters`, `characterId`,
  `eventSource`, `event_types`.
- `getTokenCountAsync` / `getTokenCount` for counting (falls back to a char/4
  heuristic if both are absent).
- `generateQuietPrompt` for background summarization (**required** for auto
  rollover; the extension reports clearly if it's missing).
- `setExtensionPrompt` for canonical-memory injection (falls back to chat
  metadata).
- `extension_settings` + `saveSettingsDebounced` for persistence.
- `reloadCurrentChat` / `printMessages` / `saveChat` for refresh (best-effort).
- Slash command registration via `SlashCommandParser`/`SlashCommand` (new) or
  `registerSlashCommand` (legacy).

World-info extraction is intentionally conservative; see `summarizer._collectLore`.

---

## License

MIT. See repository.
