# Installation

## Requirements

- A recent SillyTavern (staging or release) with the **context API**
  (`SillyTavern.getContext()`) and **background generation**
  (`generateQuietPrompt`). If you can use the built-in Summarize extension, you
  can use this one.
- A working chat-completion / text-completion connection (the extension reuses
  whatever connection SillyTavern is already configured with — no extra API key).

---

## Option A — Install via SillyTavern (recommended)

1. Launch SillyTavern.
2. Open the **Extensions** panel → **Install Extension** (the download/box icon).
3. Paste the repository URL:
   ```
   https://github.com/HamHamm1/Autochat
   ```
4. Confirm. SillyTavern clones it into `third-party/`.
5. Reload the page (F5). Expand **Auto Context Rollover** in the Extensions
   panel.

---

## Option B — Manual install

Place the folder so that `manifest.json` is at:

```
<SillyTavern>/public/scripts/extensions/third-party/st-auto-context-rollover/manifest.json
```

### Windows
```
C:\path\to\SillyTavern\public\scripts\extensions\third-party\st-auto-context-rollover\
```

### macOS / Linux
```
~/SillyTavern/public/scripts/extensions/third-party/st-auto-context-rollover/
```

Then reload SillyTavern.

### Via git clone

```bash
cd <SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/HamHamm1/Autochat.git
```

---

## Verify it loaded

1. Open the **Extensions** panel — you should see **Auto Context Rollover**.
2. Set **Mode** to **Debug**.
3. Open your browser dev console. You should see:
   ```
   [Auto-Context-Rollover] Initializing…
   [Auto-Context-Rollover] Ready.
   ```
4. Send a message; you'll see `recount(...)` lines reporting token usage.

---

## Updating

- **Option A installs:** use SillyTavern's extension update control, or
  `git pull` inside the extension folder.
- **Manual installs:** `git pull` (or re-copy the folder) and reload.

`manifest.json` sets `"auto_update": false` by default; flip it to `true` if you
want SillyTavern to auto-pull updates.

---

## Uninstall

Delete the `st-auto-context-rollover` folder from `third-party/` and reload.
Your settings live in SillyTavern's settings file under the
`st_auto_context_rollover` key; remove that key if you want a clean wipe.
