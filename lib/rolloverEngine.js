/**
 * lib/rolloverEngine.js
 * -----------------------------------------------------------------------------
 * The core orchestrator.
 *
 * Executes the atomic rollover pipeline:
 *   1. Cooldown / re-entrancy guard.
 *   2. Resolve active profile (character -> chat -> global).
 *   3. Assemble context + run summarizer (with one retry, then fallback).
 *   4. Validate the generated summary (corruption detection).
 *   5. ONLY on success: snapshot current state, inject canonical memory as a
 *      high-priority extension prompt, trim old history, reseed continuity.
 *   6. Record metadata; the previous state stays in the rollback buffer.
 *
 * Design note on "Main Prompt overwrite":
 *   The spec asks to overwrite the Main Prompt. Directly rewriting a user's
 *   preset Main Prompt is destructive and not reversible through public APIs.
 *   The correct, non-destructive equivalent — and what built-in memory does —
 *   is to inject the canonical memory via setExtensionPrompt at depth 0 with
 *   high priority, which functionally takes the role of a refreshed system
 *   memory at the top of context. We expose a config flag for users who insist
 *   on literal preset mutation, but default to the safe injection path.
 * -----------------------------------------------------------------------------
 */

import {
    getConfig, resolveProfileId, pushSnapshot, getLatestSnapshot,
    removeSnapshot, setLastRollover, getStore,
} from './storage.js';
import { getProfile, getFallbackProfile } from '../profiles/registry.js';
import { Summarizer } from './summarizer.js';
import { validateSummary, validateSnapshot } from './validators.js';

// Stable, namespaced key for our injected canonical memory prompt.
const INJECT_KEY = 'st_acr_canonical_memory';

export class RolloverEngine {
    /**
     * @param {object} deps
     * @param {object} deps.context     - getContext()
     * @param {object} deps.tokenMonitor
     * @param {function} deps.log
     * @param {object} deps.ui          - { toast, confirm, status } callbacks
     */
    constructor({ context, tokenMonitor, log, ui }) {
        this.context = context;
        this.tokenMonitor = tokenMonitor;
        this.log = log || (() => {});
        this.ui = ui || {};
        this.summarizer = new Summarizer({ context, log: this.log });

        this._running = false;       // re-entrancy guard
        this._lastRolloverTs = 0;    // cooldown anchor
    }

    /** True if we are inside the cooldown window. */
    inCooldown() {
        const cfg = getConfig();
        const elapsed = (Date.now() - this._lastRolloverTs) / 1000;
        return elapsed < cfg.cooldownSeconds;
    }

    cooldownRemaining() {
        const cfg = getConfig();
        const elapsed = (Date.now() - this._lastRolloverTs) / 1000;
        return Math.max(0, Math.ceil(cfg.cooldownSeconds - elapsed));
    }

    /**
     * Entry point for the automatic trigger from the token monitor.
     * Honors mode (silent/notify/confirm/debug) and cooldown.
     */
    async autoRollover(triggerInfo = {}) {
        const cfg = getConfig();

        if (this._running) {
            this.log('debug', 'autoRollover ignored: already running.');
            return { ok: false, reason: 'already_running' };
        }
        if (this.inCooldown()) {
            this.log('debug', `autoRollover ignored: cooldown ${this.cooldownRemaining()}s left.`);
            return { ok: false, reason: 'cooldown' };
        }

        // Confirm mode: ask first.
        if (cfg.mode === 'confirm' && typeof this.ui.confirm === 'function') {
            const ok = await this.ui.confirm(
                `Context is at ${triggerInfo.tokens || '?'} tokens. Run automatic rollover now?`,
            );
            if (!ok) {
                this.log('info', 'User declined rollover at confirm prompt.');
                return { ok: false, reason: 'declined' };
            }
        }

        return this.execute({ source: 'auto', triggerInfo });
    }

    /** Manual trigger from the settings panel / slash command. */
    async manualRollover() {
        if (this._running) return { ok: false, reason: 'already_running' };
        return this.execute({ source: 'manual' });
    }

    /**
     * Dry-run preview: run the active profile and return the summary WITHOUT
     * mutating any chat state. Used by the "Test Selected Profile" button.
     */
    async dryRunPreview() {
        const { profile, options } = this._resolveActiveProfile();
        const cfg = getConfig();
        const ctx = this.summarizer.assembleContext({
            retainedMessageCount: cfg.retainedMessageCount,
        });
        this._showProgress('กำลังทดสอบสรุป… (อาจใช้เวลาหลายนาที)');
        try {
            const summary = await this.summarizer.generate(profile, ctx, options);
            const validation = await validateSummary(summary, profile, this._tokenCounter());
            return { profile, summary, validation };
        } finally {
            await this._hideProgress();
        }
    }

    /* ----------------------------- Core pipeline ----------------------------- */

    async execute({ source, triggerInfo }) {
        this._running = true;
        const cfg = getConfig();
        const startTokens = this.tokenMonitor?.currentTokens || 0;

        try {
            this.log('info', `Rollover starting (source=${source}).`);
            this._notifyIfVerbose(cfg, 'Auto rollover starting…');

            // 1. Resolve profile (with anime sub-options if applicable).
            const { profile, options, profileLabel } = this._resolveActiveProfile();

            // 2. Assemble context.
            const ctxData = this.summarizer.assembleContext({
                retainedMessageCount: cfg.retainedMessageCount,
            });

            if (ctxData.olderCount === 0) {
                // Nothing old enough to compress; abort gracefully.
                this.log('info', 'Rollover aborted: no older history to compress.');
                if (source === 'manual') {
                    this._notify(cfg,
                        'Nothing to summarize yet — chat is shorter than the '
                        + 'Retained Message Count. Lower it or chat more first.',
                        'warning');
                }
                return { ok: false, reason: 'nothing_to_compress' };
            }

            // 3. Generate summary with one retry, then fallback profile.
            //    Show a non-blocking "summarizing…" indicator for the long wait.
            this._showProgress('กำลังสรุปเนื้อเรื่อง… (อาจใช้เวลาหลายนาที)');
            const { summary, usedProfile, usedLabel } =
                await this._generateWithRetryAndFallback(profile, profileLabel, ctxData, options);

            if (!summary) {
                this.log('error', 'Rollover aborted: summary generation failed entirely.');
                this._notify(cfg, 'Auto rollover failed: could not generate summary.', 'error');
                return { ok: false, reason: 'generation_failed' };
            }

            // 4. ATOMIC COMMIT — everything below only happens post-validation.
            const committed = await this._commit({
                summary, usedProfile, usedLabel, cfg, ctxData, startTokens, source,
            });

            return committed;
        } catch (e) {
            this.log('error', 'Rollover threw:', e);
            this._notify(getConfig(), `Auto rollover error: ${e.message}`, 'error');
            return { ok: false, reason: 'exception', error: e.message };
        } finally {
            await this._hideProgress();
            this._running = false;
        }
    }

    /* --------------------------- progress indicator --------------------------- */

    /** Show a non-blocking "working" indicator. Prefers ST's loader, then toastr. */
    _showProgress(message) {
        const ctx = this.context;
        try {
            if (ctx?.loader && typeof ctx.loader.show === 'function') {
                this._progressHandle = ctx.loader.show({
                    blocking: false,        // don't lock the UI during the long wait
                    message,
                    title: 'Auto Context Rollover',
                    toastMode: 'static',    // persistent toast, no stop button
                });
                return;
            }
        } catch (e) {
            this.log('debug', 'loader.show failed, falling back to toastr:', e?.message);
        }
        // Fallback: a sticky toastr notification that stays until cleared.
        try {
            if (globalThis.toastr) {
                this._progressToast = globalThis.toastr.info(message, 'กำลังสรุป', {
                    timeOut: 0, extendedTimeOut: 0, tapToDismiss: false,
                });
            }
        } catch (e) {
            this.log('debug', 'toastr progress failed:', e?.message);
        }
    }

    /** Hide whichever progress indicator is currently showing. */
    async _hideProgress() {
        try {
            if (this._progressHandle && typeof this._progressHandle.hide === 'function') {
                await this._progressHandle.hide();
            }
        } catch (e) {
            this.log('debug', 'loader.hide failed:', e?.message);
        }
        this._progressHandle = null;
        try {
            if (this._progressToast && globalThis.toastr) {
                globalThis.toastr.clear(this._progressToast);
            }
        } catch (e) {
            this.log('debug', 'toastr clear failed:', e?.message);
        }
        this._progressToast = null;
    }

    /**
     * Try the chosen profile (generate + validate), retry once on invalid,
     * then fall back to OC Canon Compact. Returns the first valid summary.
     */
    async _generateWithRetryAndFallback(profile, label, ctxData, options) {
        const attemptsPlan = [
            { profile, label, options, tag: 'primary' },
            { profile, label, options, tag: 'primary-retry' },
        ];

        const fallback = getFallbackProfile();
        if (fallback.id !== profile.id) {
            attemptsPlan.push({ profile: fallback, label: fallback.label, options: {}, tag: 'fallback' });
        }

        for (const attempt of attemptsPlan) {
            try {
                this.log('debug', `Generation attempt: ${attempt.tag} (${attempt.profile.id})`);
                // eslint-disable-next-line no-await-in-loop
                const summary = await this.summarizer.generate(attempt.profile, ctxData, attempt.options);
                // eslint-disable-next-line no-await-in-loop
                const validation = await validateSummary(summary, attempt.profile, this._tokenCounter());
                if (validation.valid) {
                    this.log('info',
                        `Summary valid via ${attempt.tag} (${validation.tokenCount} tokens).`);
                    return { summary, usedProfile: attempt.profile, usedLabel: attempt.label };
                }
                this.log('debug', `Attempt ${attempt.tag} invalid: ${validation.reason}`);
            } catch (e) {
                this.log('debug', `Attempt ${attempt.tag} threw: ${e.message}`);
            }
        }
        return { summary: null };
    }

    /**
     * Commit phase: snapshot -> inject -> trim -> reseed. This is the only code
     * that mutates the live chat, and it runs only after a valid summary exists.
     */
    async _commit({ summary, usedProfile, usedLabel, cfg, ctxData, startTokens, source }) {
        const ctx = this.context;
        const chat = ctx.chat;

        // 4a. Build & store a rollback snapshot of the CURRENT state first.
        const snapshot = this._buildSnapshot({ chat, summary, profileId: usedProfile.id });

        // 4b. Identify the latest assistant ({{char}}) message for continuity
        //     reseed. We must preserve it as the first retained assistant turn.
        const latestCharIndex = this._findLatestAssistantIndex(chat);

        // 4c. Compute which messages to retain.
        const retainCount = Math.min(cfg.retainedMessageCount, chat.length);
        const retainStart = Math.max(0, chat.length - retainCount);

        // Ensure the latest assistant message is inside the retained window; if
        // for some reason it's older, we splice it back in at the front so the
        // continuation anchor is never lost (no duplicated dialogue: we move,
        // not copy, and de-dupe by id below).
        const retained = chat.slice(retainStart);
        const retainedHasLatestChar = latestCharIndex >= retainStart;

        // 4d. Inject canonical memory as a high-priority extension prompt.
        this._injectCanonicalMemory(summary);

        // 4e. Optionally mutate the literal Main Prompt if the user opted in.
        if (cfg.overwriteMainPrompt) {
            this._tryOverwriteMainPrompt(summary);
        }

        // 4f. Trim: rebuild the chat array to retained window only.
        const removed = chat.slice(0, retainStart);

        // Reseed: if latest assistant msg fell outside retained window, prepend.
        let newChat = retained;
        if (!retainedHasLatestChar && latestCharIndex >= 0) {
            const latestChar = chat[latestCharIndex];
            // De-dupe guard: only prepend if not already present by reference/id.
            const already = retained.some((m) => m === latestChar);
            if (!already) {
                newChat = [latestChar, ...retained];
                this.log('debug', 'Reseeded latest assistant message at front.');
            }
        }

        // 4g. Apply the mutation in place so ST's references stay valid.
        chat.length = 0;
        for (const m of newChat) chat.push(m);

        // 4h. Persist snapshot (archive mode stores removed messages too).
        if (!cfg.archiveTrimmed) {
            // Strip heavy removed-message payload if archiving disabled — keep
            // only what rollback needs (we still keep fullChat for restore).
            snapshot.removedMessages = [];
        }
        pushSnapshot(snapshot);

        // Force IMMEDIATE (non-debounced) persistence of the rollback snapshot so
        // it survives even if a chat reload or page navigation races right after.
        // The default persist() is debounced (~1s) and can be lost on web hosts.
        try {
            if (typeof ctx.saveSettings === 'function') {
                await ctx.saveSettings();
            }
        } catch (e) {
            this.log('debug', 'Immediate snapshot persist skipped:', e?.message);
        }

        // 4i. Refresh the visible chat + token counter (awaited — see race fix).
        await this._refreshChatUI();
        this.tokenMonitor?.resetCrossing();
        this.tokenMonitor?.requestRecount('post-rollover');

        // 4j. Record metadata + cooldown anchor.
        this._lastRolloverTs = Date.now();
        const meta = {
            ts: this._lastRolloverTs,
            profileId: usedProfile.id,
            profileLabel: usedLabel,
            chatId: this._chatId(),
            tokensBefore: startTokens,
            removedCount: removed.length,
            retainedCount: newChat.length,
            source,
            snapshotId: snapshot.id,
        };
        setLastRollover(meta);

        this._notify(cfg, `Auto rollover complete using: ${usedLabel}`, 'success');
        if (typeof this.ui.status === 'function') this.ui.status();

        this.log('info',
            `Rollover committed: removed ${removed.length}, retained ${newChat.length}, ` +
            `profile=${usedProfile.id}.`);

        return { ok: true, meta };
    }

    /* ------------------------------- Rollback ------------------------------- */

    /**
     * Restore the most recent snapshot (one-click rollback). Re-inserts the full
     * pre-rollover chat and removes our injected memory.
     */
    async rollbackLast() {
        const snap = getLatestSnapshot();
        if (!validateSnapshot(snap)) {
            this._notify(getConfig(), 'No valid rollback snapshot available.', 'error');
            return { ok: false, reason: 'no_snapshot' };
        }

        const ctx = this.context;
        const chat = ctx.chat;

        if (!Array.isArray(snap.fullChat)) {
            this._notify(getConfig(), 'Snapshot missing full chat; cannot rollback.', 'error');
            return { ok: false, reason: 'incomplete_snapshot' };
        }

        // Restore the chat array in place.
        chat.length = 0;
        for (const m of snap.fullChat) chat.push(m);

        // Remove our injected canonical memory.
        this._clearCanonicalMemory();

        // Consume the snapshot so repeated rollback doesn't loop on stale state.
        removeSnapshot(snap.id);

        this._refreshChatUI();
        this.tokenMonitor?.resetCrossing();
        this.tokenMonitor?.requestRecount('post-rollback');

        this._notify(getConfig(), 'Rolled back last rollover.', 'success');
        this.log('info', `Rollback restored ${chat.length} messages from snapshot ${snap.id}.`);
        return { ok: true };
    }

    /* ------------------------------- Helpers -------------------------------- */

    _resolveActiveProfile() {
        const cfg = getConfig();
        const profileId = resolveProfileId(this._chatId(), this._characterKey());
        const profile = getProfile(profileId);

        // Anime v17 needs its sub-config + mode passed through.
        let options = {};
        if (profile.id === 'anime_story_summary_v17') {
            options = {
                animeV17: cfg.animeV17,
                // Auto rollover is autonomous => MODE B unless MODE A is the only
                // one enabled.
                mode: cfg.animeV17.modeBEnabled ? 'B' : 'A',
            };
        }
        return { profile, options, profileLabel: profile.label };
    }

    _buildSnapshot({ chat, summary, profileId }) {
        const ctx = this.context;
        return {
            id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            ts: Date.now(),
            chatId: this._chatId(),
            characterKey: this._characterKey(),
            chatMetadata: ctx.chatMetadata || ctx.chat_metadata || {},
            profileId,
            summary,
            // Full chat enables exact rollback. Deep clone so later mutation of
            // the live array can't corrupt the snapshot.
            fullChat: structuredCloneSafe(chat),
            removedMessages: [], // filled by caller depending on archive mode
        };
    }

    _findLatestAssistantIndex(chat) {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) return i;
        }
        return -1;
    }

    _injectCanonicalMemory(summary) {
        const ctx = this.context;
        const text = `[CANONICAL MEMORY — auto-maintained]\n${summary}`;
        if (typeof ctx.setExtensionPrompt === 'function') {
            // setExtensionPrompt(key, value, position, depth, scan, role)
            // position 1 = IN_PROMPT (top), depth 0, high priority.
            try {
                ctx.setExtensionPrompt(INJECT_KEY, text, 1, 0);
                this.log('debug', 'Canonical memory injected via setExtensionPrompt.');
                return;
            } catch (e) {
                this.log('debug', 'setExtensionPrompt failed, will store on metadata.', e?.message);
            }
        }
        // Fallback: stash on chat metadata so at least it persists/visible.
        try {
            ctx.chatMetadata = ctx.chatMetadata || {};
            ctx.chatMetadata[INJECT_KEY] = text;
        } catch { /* non-fatal */ }
    }

    _clearCanonicalMemory() {
        const ctx = this.context;
        if (typeof ctx.setExtensionPrompt === 'function') {
            try { ctx.setExtensionPrompt(INJECT_KEY, '', 1, 0); } catch { /* ignore */ }
        }
        if (ctx.chatMetadata) delete ctx.chatMetadata[INJECT_KEY];
    }

    _tryOverwriteMainPrompt(summary) {
        // Opt-in literal preset mutation. Only attempted if the build exposes a
        // setter; otherwise silently relies on the injection path.
        const ctx = this.context;
        try {
            if (ctx.setMainPrompt) {
                ctx.setMainPrompt(summary);
            } else if (globalThis.power_user?.prompt_manager) {
                // No stable public setter; we deliberately do nothing destructive.
                this.log('debug', 'Literal Main Prompt overwrite unsupported; using injection.');
            }
        } catch (e) {
            this.log('debug', 'Main Prompt overwrite skipped:', e?.message);
        }
    }

    async _refreshChatUI() {
        const ctx = this.context;
        try {
            // CRITICAL ORDER: persist the trimmed chat to disk FIRST and wait for
            // it to finish, THEN refresh the UI from the now-correct disk state.
            //
            // The previous order (reload-then-save, un-awaited) caused a race on
            // high-latency hosts (web hosting): reloadCurrentChat() clears the
            // in-memory chat and asynchronously refetches from the server, but
            // saveChat() fired during that gap and persisted the EMPTY array,
            // wiping the chat to 0 messages. Saving first makes the reload safe
            // even if it momentarily clears the array.
            if (typeof ctx.saveChat === 'function') {
                await ctx.saveChat();
            }
            if (typeof ctx.reloadCurrentChat === 'function') {
                await ctx.reloadCurrentChat();
            } else if (typeof ctx.printMessages === 'function') {
                ctx.printMessages();
            }
        } catch (e) {
            this.log('debug', 'Chat UI refresh partial:', e?.message);
        }
    }

    _tokenCounter() {
        const ctx = this.context;
        if (ctx.getTokenCountAsync) return (t) => ctx.getTokenCountAsync(t);
        if (ctx.getTokenCount) return (t) => Promise.resolve(ctx.getTokenCount(t));
        return (t) => Promise.resolve(Math.ceil((t || '').length / 4));
    }

    _chatId() {
        const ctx = this.context;
        return ctx.chatId || ctx.getCurrentChatId?.() || ctx.chat_metadata?.chat_id || 'default';
    }

    _characterKey() {
        const ctx = this.context;
        const ch = ctx.characters?.[ctx.characterId];
        return ch?.avatar || ch?.name || null;
    }

    _notify(cfg, message, level = 'info') {
        if (cfg.mode === 'silent') return; // fully invisible
        if (typeof this.ui.toast === 'function') this.ui.toast(message, level);
    }

    _notifyIfVerbose(cfg, message) {
        if (cfg.mode === 'debug') this._notify(cfg, message, 'info');
    }
}

/** structuredClone that tolerates non-cloneable fields by JSON round-trip. */
function structuredCloneSafe(obj) {
    try {
        return structuredClone(obj);
    } catch {
        try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
    }
}
