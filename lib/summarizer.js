/**
 * lib/summarizer.js
 * -----------------------------------------------------------------------------
 * Summarization engine.
 *
 * Responsibilities:
 *   1. Assemble runtime context (character card, lore, history, recent window).
 *   2. Ask the active profile to build its prompt.
 *   3. Run that prompt through SillyTavern's own generation backend so the user
 *      doesn't need a second API key — we reuse their configured connection via
 *      context.generateQuietPrompt (the supported "quiet"/background generation
 *      entry point that does NOT post a message to the visible chat).
 *   4. Return the raw summary text for validation.
 * -----------------------------------------------------------------------------
 */

export class Summarizer {
    /**
     * @param {object} deps
     * @param {object} deps.context - getContext() result
     * @param {function} deps.log
     */
    constructor({ context, log }) {
        this.context = context;
        this.log = log || (() => {});
    }

    /**
     * Build the structured runtime context object passed to profile.buildPrompt.
     *
     * @param {object} opts
     * @param {number} opts.retainedMessageCount - size of "recent" window
     * @returns {object} ctx
     */
    assembleContext({ retainedMessageCount }) {
        const ctx = this.context;
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];

        // --- Character card -------------------------------------------------
        const card = ctx.characters?.[ctx.characterId] || null;
        const character = card ? {
            name: card.name,
            personality: card.personality,
            scenario: card.scenario,
            description: card.description,
            mesExample: card.mes_example,
        } : null;

        // --- World info / lorebook -----------------------------------------
        // We surface whatever active entries we can read. The reliable, version-
        // stable source is the extension-prompt registry / worldInfoString if
        // exposed; otherwise we degrade to empty rather than guess.
        const loreEntries = this._collectLore();

        // --- Split history vs recent window --------------------------------
        const recentCount = Math.min(
            Math.max(retainedMessageCount, 8), // always keep at least 8 for continuity
            chat.length,
        );
        const splitIndex = Math.max(0, chat.length - recentCount);
        const older = chat.slice(0, splitIndex);
        const recent = chat.slice(splitIndex);

        const historyText = this._renderMessages(older);
        const recentText = this._renderMessages(recent);

        return {
            character,
            loreEntries,
            historyText,
            recentText,
            olderCount: older.length,
            recentCount: recent.length,
            splitIndex,
        };
    }

    _renderMessages(messages) {
        return messages.map((m) => {
            const who = m.is_user ? 'User' : (m.name || 'Char');
            // Strip nothing — fidelity matters for summarization.
            return `${who}: ${m.mes || ''}`;
        }).join('\n');
    }

    _collectLore() {
        const ctx = this.context;
        const out = [];
        try {
            // Newer ST exposes getWorldInfoPrompt / world info via context; probe.
            if (typeof ctx.getWorldInfoPrompt === 'function') {
                // Not awaited here intentionally; many builds return a string sync
                // wrapper. If it's a promise we just skip (assembleContext is sync).
                const wi = ctx.getWorldInfoPrompt;
                void wi; // documented limitation: see README "API assumptions"
            }
            if (typeof globalThis.world_info === 'object' && globalThis.world_info) {
                // Best-effort: pull entry contents if a flat structure is present.
                const entries = globalThis.world_info.entries || {};
                for (const e of Object.values(entries)) {
                    if (e && e.content && !e.disable) out.push(String(e.content));
                }
            }
        } catch (e) {
            this.log('debug', 'lore collection skipped:', e?.message);
        }
        return out.slice(0, 60); // cap to keep prompt bounded
    }

    /**
     * Run a profile's prompt through the model and return raw text.
     *
     * @param {object} profile
     * @param {object} ctx     - assembled context
     * @param {object} options - profile-specific options (e.g. animeV17 cfg/mode)
     * @returns {Promise<string>}
     */
    async generate(profile, ctx, options = {}) {
        const prompt = profile.buildPrompt(ctx, options);
        const stCtx = this.context;

        this.log('debug', `Summarizer running profile "${profile.id}" ` +
            `(prompt ~${Math.ceil(prompt.length / 4)} tokens est.)`);

        // Strategy:
        //   1) Prefer `generateRaw` — sends ONLY our prompt to the model with
        //      NO system prompt, NO character card, NO lorebook, NO [SAY]/RP
        //      framing layered on top. This is the only reliable way to get a
        //      heavily-RP-tuned bot (ROSE ENGINE etc.) to actually summarize
        //      instead of staying in character.
        //   2) Fall back to `generateQuietPrompt` only if generateRaw is
        //      unavailable in this ST build.
        let result;

        if (typeof stCtx.generateRaw === 'function') {
            try {
                // Modern object form: { prompt, systemPrompt, ... } — passing an
                // empty systemPrompt explicitly suppresses the bot's persona.
                result = await stCtx.generateRaw({
                    prompt,
                    systemPrompt: '',
                    instructOverride: true,
                    quietToLoud: false,
                });
            } catch (e1) {
                this.log('debug', 'generateRaw object form failed, trying positional', e1?.message);
                try {
                    // Positional fallback for older builds.
                    result = await stCtx.generateRaw(prompt, null, true, false, '');
                } catch (e2) {
                    this.log('debug', 'generateRaw positional failed, falling back to quiet', e2?.message);
                    result = null;
                }
            }
        }

        if (!result && typeof stCtx.generateQuietPrompt === 'function') {
            this.log('debug', 'Using generateQuietPrompt fallback (system prompt may leak through).');
            try {
                result = await stCtx.generateQuietPrompt(prompt, false, true);
            } catch (e) {
                this.log('debug', 'generateQuietPrompt 3-arg failed, retrying 1-arg', e?.message);
                result = await stCtx.generateQuietPrompt(prompt);
            }
        }

        if (!result && typeof stCtx.generateRaw !== 'function'
            && typeof stCtx.generateQuietPrompt !== 'function') {
            throw new Error(
                'Neither generateRaw nor generateQuietPrompt is available in ' +
                'this SillyTavern build; cannot run background summarization.',
            );
        }

        const raw = (result || '').trim();

        // Post-process: if the model wrote some preamble before the expected
        // template start, strip it. Heavily RP-tuned bots sometimes prepend a
        // narrative line ("She turned and..."), then comply with the template.
        // If we can find a clean start marker, slice from there.
        const markers = [
            '[STORY SUMMARY SYSTEM v17]',
            '[CANONICAL MEMORY STATE]',
            '[STORY SO FAR]',
        ];
        for (const m of markers) {
            const idx = raw.indexOf(m);
            if (idx > 0 && idx < raw.length / 2) {
                // Marker exists but isn't at the start — strip the preamble.
                this.log('debug', `Stripped ${idx} chars of preamble before "${m}".`);
                return raw.slice(idx).trim();
            }
        }

        return raw;
    }
}
