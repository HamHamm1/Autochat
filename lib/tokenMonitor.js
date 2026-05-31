/**
 * lib/tokenMonitor.js
 * -----------------------------------------------------------------------------
 * Token watcher.
 *
 * SillyTavern does NOT emit a continuous "token count changed" event. The
 * supported approach (used by the built-in Summarize extension) is to recount
 * after the events that actually change context size — message sent / received /
 * swiped / deleted / chat changed — and debounce that recount so rapid bursts
 * don't thrash the tokenizer.
 *
 * We track current usage, max context, threshold proximity and a rolling growth
 * average, then invoke a callback when the configured threshold is crossed
 * (subject to cooldown handled by the rollover engine, not here).
 * -----------------------------------------------------------------------------
 */

import { getConfig } from './storage.js';

export class TokenMonitor {
    /**
     * @param {object} deps
     * @param {object} deps.context        - SillyTavern getContext() result
     * @param {function} deps.onThreshold  - async () => void, fired on crossing
     * @param {function} deps.log          - logger(level, ...args)
     * @param {function} [deps.onUpdate]   - called after every recount so UI repaints
     */
    constructor({ context, onThreshold, log, onUpdate }) {
        this.context = context;
        this.onThreshold = onThreshold;
        this.onUpdate = onUpdate || (() => {});
        this.log = log || (() => {});

        this.currentTokens = 0;
        this.maxContext = getConfig().maxModelContext || 0;
        this.lastSamples = [];   // rolling samples for growth average
        this.lastCrossing = false; // edge-detect so we fire once per crossing
        this._debounceTimer = null;
        this._recounting = false;
    }

    /** Debounced public entry point — call after any context-changing event. */
    requestRecount(reason = '') {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this.recount(reason).catch((e) => this.log('error', 'recount failed', e));
        }, 1200); // debounce window
    }

    /** Count tokens for the full active chat using the native tokenizer. */
    async countChatTokens() {
        const ctx = this._liveContext();
        const chat = ctx.chat || [];

        // Prefer the async counter when present (newer ST); fall back to sync.
        const counter = ctx.getTokenCountAsync
            ? (t) => ctx.getTokenCountAsync(t)
            : (t) => Promise.resolve(ctx.getTokenCount ? ctx.getTokenCount(t) : Math.ceil((t || '').length / 4));

        // Concatenate message bodies. We include name prefixes because they are
        // part of what actually gets sent to the model.
        let total = 0;
        // Batch into chunks to avoid one gigantic string the tokenizer chokes on.
        const CHUNK = 50;
        for (let i = 0; i < chat.length; i += CHUNK) {
            const slice = chat.slice(i, i + CHUNK)
                .map((m) => `${m.name || ''}: ${m.mes || ''}`)
                .join('\n');
            // eslint-disable-next-line no-await-in-loop
            total += await counter(slice);
        }

        // Add character card + system overhead estimate so the threshold maps to
        // real context pressure, not just visible chat.
        try {
            const card = this._characterOverheadText();
            if (card) total += await counter(card);
        } catch { /* non-fatal */ }

        // Add ACTIVE EXTENSION PROMPTS (lorebook/world-info injections, NPC &
        // living-world modules, summaries, etc.). On most chats these dwarf the
        // visible message text, so omitting them makes the watcher fire far too
        // late. ST stores them on ctx.extensionPrompts as { key: { value } }.
        try {
            const ext = this._liveContext().extensionPrompts;
            if (ext && typeof ext === 'object') {
                const blocks = Object.values(ext)
                    .map((p) => (p && typeof p.value === 'string' ? p.value : ''))
                    .filter(Boolean);
                if (blocks.length) {
                    // Count in one combined pass (cheaper than per-key).
                    total += await counter(blocks.join('\n'));
                }
            }
        } catch { /* non-fatal */ }

        return total;
    }

    _characterOverheadText() {
        const ctx = this._liveContext();
        const ch = ctx.characters?.[ctx.characterId];
        if (!ch) return '';
        return [ch.description, ch.personality, ch.scenario, ch.mes_example]
            .filter(Boolean).join('\n');
    }

    /**
     * Refresh max context from the context object if it exposes it.
     *
     * IMPORTANT: the context object captured at construction time holds a
     * snapshot of max_context from BEFORE an API connection was established
     * (often a stale default like 8192). We therefore re-acquire a LIVE context
     * on each refresh so we read the user's real configured context size.
     */
    refreshMaxContext() {
        const ctx = this._liveContext();
        // ST's context exposes `maxContext` (see st-context.js: maxContext:
        // Number(max_context)). Probe a couple of fallbacks defensively.
        const candidates = [
            ctx.maxContext,
            ctx.max_context,
            globalThis.max_context,
        ].filter((n) => typeof n === 'number' && n > 0);
        if (candidates.length) {
            this.maxContext = candidates[0];
        } else {
            this.maxContext = getConfig().maxModelContext || this.maxContext;
        }
        return this.maxContext;
    }

    /** Re-acquire a fresh context so we don't read stale startup snapshots. */
    _liveContext() {
        try {
            if (globalThis.SillyTavern?.getContext) return globalThis.SillyTavern.getContext();
        } catch { /* fall through */ }
        return this.context;
    }

    /** Perform the actual recount + threshold edge detection. */
    async recount(reason = '') {
        if (this._recounting) return;
        this._recounting = true;
        try {
            const cfg = getConfig();
            if (!cfg.enabled) return;

            this.refreshMaxContext();
            const tokens = await this.countChatTokens();
            this.currentTokens = tokens;

            // Rolling growth average over last few samples.
            this.lastSamples.push({ t: Date.now(), tokens });
            if (this.lastSamples.length > 8) this.lastSamples.shift();

            const proximity = this.maxContext > 0
                ? tokens / this.maxContext
                : 0;

            this.log('debug',
                `recount(${reason}) tokens=${tokens} max=${this.maxContext} ` +
                `proximity=${(proximity * 100).toFixed(1)}% threshold=${cfg.triggerThreshold}`);

            const overThreshold = tokens >= cfg.triggerThreshold;

            // Edge detection: only fire when we transition from under -> over,
            // so we don't re-fire every recount while sitting above threshold.
            if (overThreshold && !this.lastCrossing) {
                this.lastCrossing = true;
                this.log('info', `Threshold crossed at ${tokens} tokens. Triggering rollover.`);
                await this.onThreshold({
                    tokens,
                    maxContext: this.maxContext,
                    growthPerMin: this.growthPerMinute(),
                });
            } else if (!overThreshold) {
                // Reset the edge once we drop back under (e.g. after a rollover).
                this.lastCrossing = false;
            }
        } finally {
            this._recounting = false;
            // Notify any UI listener (settings panel) so it repaints with the
            // freshly counted value rather than a stale startup snapshot.
            try { this.onUpdate(this.getStatus()); } catch { /* non-fatal */ }
        }
    }

    /** Estimated token growth per minute from rolling samples. */
    growthPerMinute() {
        if (this.lastSamples.length < 2) return 0;
        const first = this.lastSamples[0];
        const last = this.lastSamples[this.lastSamples.length - 1];
        const dtMin = (last.t - first.t) / 60000;
        if (dtMin <= 0) return 0;
        return Math.round((last.tokens - first.tokens) / dtMin);
    }

    /** Force the edge flag down — called by the engine right after a rollover. */
    resetCrossing() {
        this.lastCrossing = false;
        this.lastSamples = [];
    }

    getStatus() {
        return {
            currentTokens: this.currentTokens,
            maxContext: this.maxContext,
            proximity: this.maxContext > 0 ? this.currentTokens / this.maxContext : 0,
            growthPerMinute: this.growthPerMinute(),
        };
    }
}
