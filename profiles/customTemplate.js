/**
 * profiles/customTemplate.js
 * -----------------------------------------------------------------------------
 * PROFILE 3: CUSTOM_USER_TEMPLATE
 *
 * Lets users author their own summarization prompt. The stored custom profile
 * is a plain data object (id, label, template, tokenCap, requiredHeaders). This
 * module turns that data into a live profile object the engine can run.
 *
 * The user's `template` string may contain placeholder tokens which we replace
 * with runtime context at build time:
 *   {{character}}  -> character card block
 *   {{lore}}       -> active world info block
 *   {{history}}    -> full (older) conversation history text
 *   {{recent}}     -> most-recent exchanges text
 *   {{maxTokens}}  -> the configured token cap
 * -----------------------------------------------------------------------------
 */

function characterBlock(ctx) {
    if (!ctx.character) return '(no character card)';
    const c = ctx.character;
    return [
        c.name ? `Name: ${c.name}` : '',
        c.personality ? `Personality: ${c.personality}` : '',
        c.scenario ? `Scenario: ${c.scenario}` : '',
        c.description ? `Description: ${c.description}` : '',
        c.mesExample ? `Example dialogue: ${c.mesExample}` : '',
    ].filter(Boolean).join('\n');
}

function loreBlock(ctx) {
    if (!ctx.loreEntries?.length) return '(no active world info)';
    return ctx.loreEntries.map((e, i) => `[L${i + 1}] ${e}`).join('\n');
}

/**
 * Build a runnable profile object from a stored custom-profile data record.
 * @param {object} data - { id, label, template, tokenCap?, requiredHeaders? }
 */
export function makeCustomProfile(data) {
    const tokenCap = Number(data.tokenCap) > 0 ? Number(data.tokenCap) : 2000;
    const requiredHeaders = Array.isArray(data.requiredHeaders) ? data.requiredHeaders : [];

    return {
        id: data.id,
        label: data.label || 'Custom Template',
        description: data.description || 'User-defined summarization prompt.',
        tokenCap,
        defaultTrigger: Number(data.defaultTrigger) || 145000,
        requiredHeaders,
        isCustom: true,
        // Keep the raw record around so the editor can round-trip it.
        raw: data,

        buildPrompt(ctx) {
            const template = data.template || DEFAULT_CUSTOM_TEMPLATE;
            return template
                .replaceAll('{{character}}', characterBlock(ctx))
                .replaceAll('{{lore}}', loreBlock(ctx))
                .replaceAll('{{history}}', ctx.historyText || '')
                .replaceAll('{{recent}}', ctx.recentText || '')
                .replaceAll('{{maxTokens}}', String(tokenCap));
        },

        validate(summary) {
            for (const h of requiredHeaders) {
                if (!summary.includes(h)) {
                    return { valid: false, reason: `Missing required header: ${h}` };
                }
            }
            return { valid: true };
        },
    };
}

/** Seed template shown in the editor when a user creates a brand-new profile. */
export const DEFAULT_CUSTOM_TEMPLATE = [
    'You are a memory compression engine for a roleplay. Summarize the context',
    'below into a structured memory under {{maxTokens}} tokens. Output only the',
    'structure, no commentary.',
    '',
    '[SUMMARY]',
    '- arc:',
    '- world:',
    '- relationships:',
    '- open threads:',
    '- scene anchor:',
    '',
    '=== CHARACTER ===',
    '{{character}}',
    '',
    '=== WORLD INFO ===',
    '{{lore}}',
    '',
    '=== HISTORY ===',
    '{{history}}',
    '',
    '=== RECENT ===',
    '{{recent}}',
].join('\n');
