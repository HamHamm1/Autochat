/**
 * ui/settingsPanel.js
 * -----------------------------------------------------------------------------
 * Builds the settings panel inside SillyTavern's Extensions menu, plus the
 * inline top-bar quick-switch profile selector.
 *
 * All controls read/write through storage.js so changes persist immediately.
 * The panel is plain DOM (no framework) to match ST's extension conventions.
 * -----------------------------------------------------------------------------
 */

import {
    getConfig, updateConfig, setProfileScope, resolveProfileId,
    getCustomProfiles, saveCustomProfile, deleteCustomProfile,
    getSnapshots, clearSnapshots, getLastRollover,
    snapshotToJsonl, snapshotToJsonlWithSummary,
} from '../lib/storage.js';
import {
    listProfiles, getProfile, suggestsAnimeProfile, CUSTOM_SELECTOR_ID,
} from '../profiles/registry.js';
import { DEFAULT_CUSTOM_TEMPLATE } from '../profiles/customTemplate.js';
import { toast, showTextModal } from './toast.js';

/**
 * @param {object} deps
 * @param {object} deps.engine        - RolloverEngine instance
 * @param {object} deps.tokenMonitor  - TokenMonitor instance
 * @param {function} deps.getContext  - () => ST context
 * @param {function} deps.log
 * @param {function} deps.onProfileChange - refresh quick-switch after change
 */
export function buildSettingsPanel(deps) {
    const { engine, tokenMonitor, getContext, log } = deps;

    const root = document.createElement('div');
    root.className = 'acr-settings';
    root.innerHTML = PANEL_HTML;

    // Mount into the ST extensions settings container.
    const host = document.getElementById('extensions_settings')
        || document.getElementById('extensions_settings2')
        || document.body;
    host.appendChild(root);

    /* -------------------------- element references -------------------------- */
    const $ = (sel) => root.querySelector(sel);

    const els = {
        enabled: $('#acr_enabled'),
        threshold: $('#acr_threshold'),
        thresholdVal: $('#acr_threshold_val'),
        summaryMax: $('#acr_summary_max'),
        summaryMaxVal: $('#acr_summary_max_val'),
        retained: $('#acr_retained'),
        retainedVal: $('#acr_retained_val'),
        mode: $('#acr_mode'),
        cooldown: $('#acr_cooldown'),
        archive: $('#acr_archive'),
        profileSelect: $('#acr_profile'),
        profileDesc: $('#acr_profile_desc'),
        scopeGlobal: $('#acr_scope_global'),
        scopeChat: $('#acr_scope_chat'),
        scopeChar: $('#acr_scope_char'),
        suggestNote: $('#acr_suggest_note'),

        animeBox: $('#acr_anime_box'),
        animeModeA: $('#acr_anime_mode_a'),
        animeModeB: $('#acr_anime_mode_b'),
        animeSnapThreshold: $('#acr_anime_snap_threshold'),
        animeSnapVal: $('#acr_anime_snap_val'),
        animeSeal: $('#acr_anime_seal'),
        animeAntiRetcon: $('#acr_anime_antiretcon'),

        customBox: $('#acr_custom_box'),
        customName: $('#acr_custom_name'),
        customTemplate: $('#acr_custom_template'),
        customHeaders: $('#acr_custom_headers'),
        customCap: $('#acr_custom_cap'),
        customSave: $('#acr_custom_save'),
        customDuplicate: $('#acr_custom_duplicate'),
        customDelete: $('#acr_custom_delete'),
        customExport: $('#acr_custom_export'),
        customImport: $('#acr_custom_import'),
        customImportFile: $('#acr_custom_import_file'),

        btnManual: $('#acr_btn_manual'),
        btnRollback: $('#acr_btn_rollback'),
        btnEditMemory: $('#acr_btn_edit_memory'),
        btnTest: $('#acr_btn_test'),
        btnExport: $('#acr_btn_export'),
        btnImport: $('#acr_btn_import'),
        importFile: $('#acr_import_file'),
        btnClear: $('#acr_btn_clear'),

        status: $('#acr_status'),
    };

    /* ----------------------------- initial fill ----------------------------- */
    function refreshFromConfig() {
        const cfg = getConfig();
        els.enabled.checked = cfg.enabled;
        els.threshold.value = cfg.triggerThreshold;
        els.thresholdVal.textContent = cfg.triggerThreshold.toLocaleString();
        els.summaryMax.value = cfg.summaryMaxTokens;
        els.summaryMaxVal.textContent = cfg.summaryMaxTokens;
        els.retained.value = cfg.retainedMessageCount;
        els.retainedVal.textContent = cfg.retainedMessageCount;
        els.mode.value = cfg.mode;
        els.cooldown.value = cfg.cooldownSeconds;
        els.archive.checked = cfg.archiveTrimmed;

        // Anime sub-options.
        els.animeModeA.checked = cfg.animeV17.modeAEnabled;
        els.animeModeB.checked = cfg.animeV17.modeBEnabled;
        els.animeSnapThreshold.value = cfg.animeV17.autonomousSnapshotThreshold;
        els.animeSnapVal.textContent = cfg.animeV17.autonomousSnapshotThreshold.toLocaleString();
        els.animeSeal.value = cfg.animeV17.eventSealTriggerCount;
        els.animeAntiRetcon.checked = cfg.animeV17.antiRetconRepair;

        refreshProfileSelect();
        refreshStatus();
    }

    function refreshProfileSelect() {
        const profiles = listProfiles();
        const activeId = resolveProfileId(currentChatId(), currentCharacterKey());

        els.profileSelect.innerHTML = '';
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.label;
            els.profileSelect.appendChild(opt);
        }
        els.profileSelect.value = profiles.some((p) => p.id === activeId)
            ? activeId : 'oc_canon_compact';

        updateProfileDescription();
        maybeSuggestAnime();
    }

    function updateProfileDescription() {
        const id = els.profileSelect.value;
        const prof = getProfile(id);
        els.profileDesc.textContent = prof.description || '';

        // Toggle advanced boxes.
        els.animeBox.style.display = id === 'anime_story_summary_v17' ? '' : 'none';
        const isCustom = id === CUSTOM_SELECTOR_ID
            || !!getCustomProfiles()[id];
        els.customBox.style.display = isCustom ? '' : 'none';
        if (isCustom) loadCustomEditor(id);
    }

    function maybeSuggestAnime() {
        const ctx = getContext();
        const ch = ctx.characters?.[ctx.characterId];
        const id = els.profileSelect.value;
        if (id !== 'anime_story_summary_v17' && suggestsAnimeProfile({
            name: ch?.name, personality: ch?.personality, scenario: ch?.scenario,
            description: ch?.description, mesExample: ch?.mes_example,
        })) {
            els.suggestNote.style.display = '';
        } else {
            els.suggestNote.style.display = 'none';
        }
    }

    function paintStatus() {
        const s = tokenMonitor.getStatus();
        const last = getLastRollover();
        const snaps = getSnapshots();
        els.status.innerHTML =
            `Tokens: <b>${s.currentTokens.toLocaleString()}</b> / `
            + `${(s.maxContext || 0).toLocaleString()} `
            + `(${(s.proximity * 100).toFixed(1)}%) · growth ~${s.growthPerMinute}/min<br>`
            + `Snapshots: ${snaps.length} · `
            + (last
                ? `Last rollover: ${new Date(last.ts).toLocaleString()} via ${last.profileLabel}`
                : 'No rollovers yet');
    }

    /**
     * Repaint the status line. By default this also kicks off a FRESH live
     * recount (not just reading the last cached value) and repaints again once
     * the count resolves — so opening the panel always shows real current usage
     * rather than a stale startup snapshot. Pass {recount:false} to only repaint.
     */
    function refreshStatus(opts = {}) {
        paintStatus(); // immediate paint with whatever we have
        if (opts.recount === false) return;
        // Trigger a live recount, then repaint with the fresh number.
        Promise.resolve(tokenMonitor.recount('panel'))
            .then(() => paintStatus())
            .catch(() => { /* non-fatal */ });
    }

    /* ------------------------------ scope read ------------------------------ */
    function currentScope() {
        if (els.scopeChar.checked) return 'character';
        if (els.scopeChat.checked) return 'chat';
        return 'global';
    }
    function currentChatId() {
        const ctx = getContext();
        return ctx.chatId || ctx.getCurrentChatId?.() || 'default';
    }
    function currentCharacterKey() {
        const ctx = getContext();
        const ch = ctx.characters?.[ctx.characterId];
        return ch?.avatar || ch?.name || null;
    }

    /* ----------------------------- custom editor ---------------------------- */
    function loadCustomEditor(id) {
        const customs = getCustomProfiles();
        const data = customs[id];
        if (data) {
            els.customName.value = data.label || '';
            els.customTemplate.value = data.template || DEFAULT_CUSTOM_TEMPLATE;
            els.customHeaders.value = (data.requiredHeaders || []).join(', ');
            els.customCap.value = data.tokenCap || 2000;
        } else {
            // Fresh custom selector — seed defaults.
            els.customName.value = '';
            els.customTemplate.value = DEFAULT_CUSTOM_TEMPLATE;
            els.customHeaders.value = '';
            els.customCap.value = 2000;
        }
    }

    function readCustomEditor() {
        const label = els.customName.value.trim() || 'Custom Template';
        const id = `custom_${slug(label)}`;
        return {
            type: 'st_acr_profile',
            id,
            label,
            template: els.customTemplate.value,
            requiredHeaders: els.customHeaders.value
                .split(',').map((s) => s.trim()).filter(Boolean),
            tokenCap: Number(els.customCap.value) || 2000,
            description: 'User-defined summarization prompt.',
        };
    }

    /* --------------------------- snapshot picker ---------------------------- */
    /**
     * Show a modal listing each stored snapshot (1, 2, 3...). Tapping one exports
     * it as a SillyTavern-importable .jsonl file. Newest snapshot is #1.
     */
    async function showSnapshotPicker(snaps) {
        // Build the list. Newest = #1. Each entry must show on its OWN line.
        const rowsArr = snaps.map((s, i) => {
            const when = new Date(s.ts).toLocaleString();
            const msgs = Array.isArray(s.fullChat) ? s.fullChat.length : 0;
            const prof = s.profileLabel || s.profileId || '?';
            return `${i + 1}.  ${when} · ${msgs} msgs · ${prof}`;
        });
        // Popups render the message as HTML and collapse "\n" into spaces, so we
        // join with <br> to force one snapshot per line; plain text for fallbacks.
        const rowsHtml = rowsArr.map((r) => escapeHtmlLocal(r)).join('<br>');
        const rowsPlain = rowsArr.join('\n');

        const ctx = getContext();
        let choiceStr = null;
        try {
            if (ctx?.Popup?.show?.input) {
                choiceStr = await ctx.Popup.show.input(
                    'Export snapshot as .jsonl',
                    `Type the NUMBER of the snapshot to export:<br><br>${rowsHtml}`,
                );
            } else if (typeof ctx?.callPopup === 'function') {
                choiceStr = await ctx.callPopup(
                    `<h3>Export snapshot as .jsonl</h3>`
                    + `<p>Type the NUMBER of the snapshot to export:</p>`
                    + `<pre style="white-space:pre-wrap;text-align:left;">${escapeHtmlLocal(rowsPlain)}</pre>`
                    + `<input type="number" min="1" max="${snaps.length}" id="acr_snap_choice" class="text_pole" value="1">`,
                    'input',
                );
                const field = document.getElementById('acr_snap_choice');
                if (field && field.value) choiceStr = field.value;
            } else {
                // eslint-disable-next-line no-alert
                choiceStr = globalThis.prompt
                    ? globalThis.prompt(`Export which snapshot?\n${rowsPlain}`, '1')
                    : '1';
            }
        } catch {
            choiceStr = null;
        }

        if (choiceStr === null || choiceStr === false || `${choiceStr}`.trim() === '') return;
        const idx = parseInt(`${choiceStr}`.trim(), 10) - 1;
        if (Number.isNaN(idx) || idx < 0 || idx >= snaps.length) {
            toast('Invalid snapshot number.', 'warning');
            return;
        }

        const snap = snaps[idx];
        // Export WITH the canonical-memory summary prepended, so the re-imported
        // chat starts already "remembering" the story.
        const jsonl = snapshotToJsonlWithSummary(snap, {});
        const stamp = new Date(snap.ts).toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadText(`acr_snapshot_${idx + 1}_${stamp}.jsonl`, jsonl);
        toast(`Exported snapshot #${idx + 1} as .jsonl`, 'success');
    }

    /* ------------------------------- listeners ------------------------------ */
    els.enabled.addEventListener('change', () => {
        updateConfig({ enabled: els.enabled.checked });
    });
    els.threshold.addEventListener('input', () => {
        els.thresholdVal.textContent = Number(els.threshold.value).toLocaleString();
    });
    els.threshold.addEventListener('change', () => {
        updateConfig({ triggerThreshold: Number(els.threshold.value) });
    });
    els.summaryMax.addEventListener('input', () => {
        els.summaryMaxVal.textContent = els.summaryMax.value;
    });
    els.summaryMax.addEventListener('change', () => {
        updateConfig({ summaryMaxTokens: Number(els.summaryMax.value) });
    });
    els.retained.addEventListener('input', () => {
        els.retainedVal.textContent = els.retained.value;
    });
    els.retained.addEventListener('change', () => {
        updateConfig({ retainedMessageCount: Number(els.retained.value) });
    });
    els.mode.addEventListener('change', () => updateConfig({ mode: els.mode.value }));
    els.cooldown.addEventListener('change', () => {
        updateConfig({ cooldownSeconds: Number(els.cooldown.value) });
    });
    els.archive.addEventListener('change', () => {
        updateConfig({ archiveTrimmed: els.archive.checked });
    });

    // Profile selection + scope.
    els.profileSelect.addEventListener('change', () => {
        const scope = currentScope();
        setProfileScope({
            scope,
            profileId: els.profileSelect.value,
            chatId: currentChatId(),
            characterKey: currentCharacterKey(),
        });
        updateProfileDescription();
        toast(`Profile set (${scope}): ${getProfile(els.profileSelect.value).label}`, 'success');
        deps.onProfileChange?.();
    });

    // Anime sub-options.
    els.animeModeA.addEventListener('change', () =>
        updateConfig({ animeV17: { modeAEnabled: els.animeModeA.checked } }));
    els.animeModeB.addEventListener('change', () =>
        updateConfig({ animeV17: { modeBEnabled: els.animeModeB.checked } }));
    els.animeSnapThreshold.addEventListener('input', () => {
        els.animeSnapVal.textContent = Number(els.animeSnapThreshold.value).toLocaleString();
    });
    els.animeSnapThreshold.addEventListener('change', () =>
        updateConfig({ animeV17: { autonomousSnapshotThreshold: Number(els.animeSnapThreshold.value) } }));
    els.animeSeal.addEventListener('change', () =>
        updateConfig({ animeV17: { eventSealTriggerCount: Number(els.animeSeal.value) } }));
    els.animeAntiRetcon.addEventListener('change', () =>
        updateConfig({ animeV17: { antiRetconRepair: els.animeAntiRetcon.checked } }));

    // Custom profile editor actions.
    els.customSave.addEventListener('click', () => {
        const data = readCustomEditor();
        saveCustomProfile(data);
        refreshProfileSelect();
        els.profileSelect.value = data.id;
        setProfileScope({
            scope: currentScope(), profileId: data.id,
            chatId: currentChatId(), characterKey: currentCharacterKey(),
        });
        updateProfileDescription();
        toast(`Saved custom profile: ${data.label}`, 'success');
        deps.onProfileChange?.();
    });
    els.customDuplicate.addEventListener('click', () => {
        const data = readCustomEditor();
        data.label = `${data.label} Copy`;
        data.id = `custom_${slug(data.label)}`;
        saveCustomProfile(data);
        refreshProfileSelect();
        els.profileSelect.value = data.id;
        updateProfileDescription();
        toast(`Duplicated profile as: ${data.label}`, 'success');
    });
    els.customDelete.addEventListener('click', () => {
        const id = els.profileSelect.value;
        if (!getCustomProfiles()[id]) {
            toast('Select a saved custom profile to delete.', 'warning');
            return;
        }
        deleteCustomProfile(id);
        refreshProfileSelect();
        toast('Deleted custom profile.', 'success');
        deps.onProfileChange?.();
    });
    els.customExport.addEventListener('click', () => {
        const data = readCustomEditor();
        downloadJson(`${data.id}.json`, data);
    });
    els.customImport.addEventListener('click', () => els.customImportFile.click());
    els.customImportFile.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data.type !== 'st_acr_profile') throw new Error('Not a profile export.');
            saveCustomProfile(data);
            refreshProfileSelect();
            toast(`Imported profile: ${data.label}`, 'success');
        } catch (err) {
            toast(`Import failed: ${err.message}`, 'error');
        } finally {
            e.target.value = '';
        }
    });

    // Action buttons.
    els.btnManual.addEventListener('click', async () => {
        toast('Manual rollover started…', 'info');
        const res = await engine.manualRollover();
        if (!res.ok) toast(`Rollover did not run: ${res.reason}`, 'warning');
        refreshStatus();
    });
    els.btnRollback.addEventListener('click', async () => {
        await engine.rollbackLast();
        refreshStatus();
    });
    els.btnEditMemory.addEventListener('click', async () => {
        await engine.editInjectedMemory();
        refreshStatus();
    });
    els.btnTest.addEventListener('click', async () => {
        toast('Running dry-run preview…', 'info');
        try {
            const { profile, summary, validation } = await engine.dryRunPreview();
            const header = `Profile: ${profile.label}\n`
                + `Valid: ${validation.valid} `
                + `${validation.reason ? `(${validation.reason})` : ''} `
                + `${validation.tokenCount ? `· ${validation.tokenCount} tokens` : ''}\n`
                + '------------------------------------------------------------\n';
            await showTextModal('Summary Preview', header + summary);
        } catch (err) {
            toast(`Preview failed: ${err.message}`, 'error');
        }
    });
    els.btnExport.addEventListener('click', async () => {
        const snaps = getSnapshots();
        if (!snaps.length) { toast('No snapshots to export.', 'warning'); return; }
        await showSnapshotPicker(snaps);
    });
    els.btnImport.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (data.type !== 'st_acr_snapshot' || !Array.isArray(data.snapshots)) {
                throw new Error('Not a snapshot export.');
            }
            // Import is additive; engine reads snapshots[0] for rollback.
            const { pushSnapshot } = await import('../lib/storage.js');
            for (const s of data.snapshots.reverse()) pushSnapshot(s);
            toast(`Imported ${data.snapshots.length} snapshot(s).`, 'success');
            refreshStatus();
        } catch (err) {
            toast(`Import failed: ${err.message}`, 'error');
        } finally {
            e.target.value = '';
        }
    });
    els.btnClear.addEventListener('click', () => {
        clearSnapshots();
        toast('Cleared all snapshots.', 'success');
        refreshStatus();
    });

    refreshFromConfig();

    // Public surface the controller can call to keep UI fresh.
    return {
        root,
        refresh: refreshFromConfig,
        refreshStatus,
        refreshProfileSelect,
    };
}

/* -------------------------------- helpers --------------------------------- */

function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'profile';
}

function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Download raw text (used for .jsonl chat exports). */
function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function escapeHtmlLocal(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/* ------------------------------- panel HTML ------------------------------- */

const PANEL_HTML = `
<div class="inline-drawer acr-drawer">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Auto Context Rollover</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">

    <label class="acr-row checkbox_label">
      <input type="checkbox" id="acr_enabled"> Enable Auto Rollover
    </label>

    <div id="acr_status" class="acr-status"></div>

    <hr>

    <label class="acr-row">Summary Profile:
      <select id="acr_profile" class="text_pole"></select>
    </label>
    <div id="acr_profile_desc" class="acr-desc"></div>
    <div id="acr_suggest_note" class="acr-suggest" style="display:none;">
      This character looks anime/lore-heavy — consider <b>Anime Story Summary v17</b>.
    </div>

    <div class="acr-scope">
      Apply To:
      <label class="checkbox_label"><input type="radio" name="acr_scope" id="acr_scope_global" checked> Global Default</label>
      <label class="checkbox_label"><input type="radio" name="acr_scope" id="acr_scope_chat"> Current Chat Only</label>
      <label class="checkbox_label"><input type="radio" name="acr_scope" id="acr_scope_char"> Current Character Only</label>
    </div>

    <!-- Anime v17 advanced -->
    <div id="acr_anime_box" class="acr-subbox" style="display:none;">
      <b>Anime Story Summary v17 — Advanced</b>
      <label class="checkbox_label"><input type="checkbox" id="acr_anime_mode_a"> MODE A (user-triggered)</label>
      <label class="checkbox_label"><input type="checkbox" id="acr_anime_mode_b"> MODE B (autonomous snapshot)</label>
      <label class="acr-row">Autonomous snapshot threshold: <span id="acr_anime_snap_val"></span>
        <input type="range" id="acr_anime_snap_threshold" min="40000" max="190000" step="1000">
      </label>
      <label class="acr-row">Event seal trigger count:
        <input type="number" id="acr_anime_seal" min="1" max="100" class="text_pole acr-num">
      </label>
      <label class="checkbox_label"><input type="checkbox" id="acr_anime_antiretcon"> Anti-retcon repair</label>
    </div>

    <!-- Custom template editor -->
    <div id="acr_custom_box" class="acr-subbox" style="display:none;">
      <b>Custom Template</b>
      <label class="acr-row">Name:
        <input type="text" id="acr_custom_name" class="text_pole" placeholder="My Profile">
      </label>
      <label class="acr-row">Token cap:
        <input type="number" id="acr_custom_cap" class="text_pole acr-num" min="500" max="4000">
      </label>
      <label class="acr-row">Required headers (comma-separated):
        <input type="text" id="acr_custom_headers" class="text_pole" placeholder="[SUMMARY]">
      </label>
      <label class="acr-row">Prompt template:
        <textarea id="acr_custom_template" class="text_pole" rows="10"
          placeholder="Use {{character}} {{lore}} {{history}} {{recent}} {{maxTokens}}"></textarea>
      </label>
      <div class="acr-btnrow">
        <button id="acr_custom_save" class="menu_button">Save</button>
        <button id="acr_custom_duplicate" class="menu_button">Duplicate</button>
        <button id="acr_custom_delete" class="menu_button">Delete</button>
        <button id="acr_custom_export" class="menu_button">Export</button>
        <button id="acr_custom_import" class="menu_button">Import</button>
        <input type="file" id="acr_custom_import_file" accept="application/json" hidden>
      </div>
    </div>

    <hr>

    <label class="acr-row">Trigger Threshold (tokens): <span id="acr_threshold_val"></span>
      <input type="range" id="acr_threshold" min="40000" max="190000" step="1000">
    </label>

    <label class="acr-row">Summary Max Tokens: <span id="acr_summary_max_val"></span>
      <input type="range" id="acr_summary_max" min="500" max="4000" step="50">
    </label>

    <label class="acr-row">Retained Message Count: <span id="acr_retained_val"></span>
      <input type="range" id="acr_retained" min="4" max="50" step="1">
    </label>

    <label class="acr-row">Mode:
      <select id="acr_mode" class="text_pole">
        <option value="silent">Silent Auto (invisible)</option>
        <option value="notify">Notify (toast)</option>
        <option value="confirm">Confirm (ask first)</option>
        <option value="debug">Debug (verbose)</option>
      </select>
    </label>

    <label class="acr-row">Cooldown (seconds):
      <input type="number" id="acr_cooldown" class="text_pole acr-num" min="0" max="3600">
    </label>

    <label class="checkbox_label"><input type="checkbox" id="acr_archive"> Archive trimmed messages in snapshots</label>

    <hr>

    <div class="acr-btnrow">
      <button id="acr_btn_manual" class="menu_button">Manual Trigger</button>
      <button id="acr_btn_rollback" class="menu_button">Rollback Last</button>
      <button id="acr_btn_edit_memory" class="menu_button">Edit Memory</button>
      <button id="acr_btn_test" class="menu_button">Test Selected Profile</button>
    </div>
    <div class="acr-btnrow">
      <button id="acr_btn_export" class="menu_button">Export Chat (.jsonl)</button>
      <button id="acr_btn_import" class="menu_button">Import Snapshot</button>
      <button id="acr_btn_clear" class="menu_button">Clear Snapshots</button>
      <input type="file" id="acr_import_file" accept="application/json" hidden>
    </div>

  </div>
</div>
`;
