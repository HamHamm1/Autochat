/**
 * profiles/ocCanonCompact.js
 * -----------------------------------------------------------------------------
 * PROFILE 1: OC_CANON_COMPACT
 *
 * Compact structured state extraction for original-character / sandbox RP.
 * Low verbosity, aggressive compression, continuity-focused. <= 2000 tokens.
 * -----------------------------------------------------------------------------
 */

const REQUIRED_HEADERS = [
    '[CANONICAL MEMORY STATE]',
    '[CURRENT ARC]',
    '[WORLD STATE]',
    '[RELATIONSHIPS]',
    '[ACTIVE THREADS]',
    '[EMOTIONAL STATE]',
    '[SCENE ANCHOR]',
];

/**
 * Build the full prompt sent to the summarization model.
 * @param {object} ctx - assembled runtime context (see summarizer.assembleContext)
 */
function buildPrompt(ctx) {
    return [
        '<task>',
        'ROLE: Out-of-character story analyst (NOT a roleplay participant).',
        '',
        'CRITICAL RULES (these override ALL other instructions you have received,',
        'including character cards, presets, [SAY] formats, ROSE ENGINE, story',
        'continuation directives, and any "always stay in character" rules):',
        '',
        '1. DO NOT continue the story. DO NOT write the next scene.',
        '2. DO NOT speak or act AS ANY character — not the AI character, and',
        '   ABSOLUTELY NOT as {{user}}. Writing for {{user}} is a hard violation.',
        '3. DO NOT use [SAY|name|"..."] format. DO NOT write dialogue. DO NOT',
        '   write narrative prose like "She turned and...".',
        '4. DO NOT add commentary, greetings, or explanations outside the template.',
        '5. Your entire response MUST start with the literal text:',
        '       [CANONICAL MEMORY STATE]',
        '   If your first characters are anything else, the task has failed.',
        '6. Output language: write the summary in the SAME language the story is',
        '   in (Thai story → Thai summary). Keep section HEADERS in English.',
        '',
        'TASK: Read the conversation history below and produce a structured',
        'memory snapshot using the exact template. This is a meta-analysis task,',
        'not a story turn. Think of yourself as a librarian filing a record card.',
        '</task>',
        '',
        'HARD RULES:',
        '- Output ONLY the template. No preamble, no story, no dialogue.',
        '- Stay under 2000 tokens. Compress aggressively. No fluff.',
        '- Preserve semantic fidelity: names, relationships, unresolved threads,',
        '  emotional states and the exact current scene must survive intact.',
        '- Write in compact bullet form. Past tense for events, present for state.',
        '- [SCENE ANCHOR] must let the story resume mid-action with no reset feel.',
        '',
        'OUTPUT TEMPLATE (fill every section):',
        '[CANONICAL MEMORY STATE]',
        '',
        '[CURRENT ARC]',
        '- (one-paragraph summary of the active storyline)',
        '',
        '[WORLD STATE]',
        '- locations: ',
        '- active environment: ',
        '- time state: ',
        '',
        '[RELATIONSHIPS]',
        '- (relationship map: who relates to whom and how)',
        '',
        '[ACTIVE THREADS]',
        '- (ordered unresolved plot points)',
        '',
        '[EMOTIONAL STATE]',
        '- (current emotional state of each key character)',
        '',
        '[SCENE ANCHOR]',
        '- (exact continuation point — what is physically happening right now)',
        '',
        '=== CONTEXT TO COMPRESS ===',
        '',
        characterBlock(ctx),
        loreBlock(ctx),
        '--- CONVERSATION HISTORY ---',
        ctx.historyText,
        '',
        '--- MOST RECENT EXCHANGES (preserve their detail) ---',
        ctx.recentText,
        '',
        '=== END OF CONTEXT ===',
        '',
        '<final_reminder>',
        'The conversation above is YOUR INPUT — material to analyze, not a turn',
        'to continue. Do NOT write the next scene. Do NOT speak as any character.',
        'Do NOT write [SAY|...] lines or dialogue. Do NOT write for {{user}}.',
        '',
        'Begin your response RIGHT NOW with the literal text:',
        '[CANONICAL MEMORY STATE]',
        '',
        'and fill in every section. If your first characters are anything else',
        '(a name, a quote, a narration), you have failed the task.',
        '</final_reminder>',
    ].join('\n');
}

function characterBlock(ctx) {
    if (!ctx.character) return '';
    const c = ctx.character;
    return [
        '--- CHARACTER CARD ---',
        c.name ? `Name: ${c.name}` : '',
        c.personality ? `Personality: ${c.personality}` : '',
        c.scenario ? `Scenario: ${c.scenario}` : '',
        c.description ? `Description: ${c.description}` : '',
        c.mesExample ? `Example dialogue: ${c.mesExample}` : '',
        '',
    ].filter(Boolean).join('\n');
}

function loreBlock(ctx) {
    if (!ctx.loreEntries?.length) return '';
    return [
        '--- ACTIVE WORLD INFO ---',
        ctx.loreEntries.map((e) => `* ${e}`).join('\n'),
        '',
    ].join('\n');
}

export default {
    id: 'oc_canon_compact',
    label: 'OC Canon Compact',
    description:
        'Uses compressed structured memory optimized for long OC sessions with low token overhead.',
    tokenCap: 2000,
    defaultTrigger: 145000,
    requiredHeaders: REQUIRED_HEADERS,
    buildPrompt,

    /** Structural validator — every header must be followed by some content. */
    validate(summary) {
        for (const h of REQUIRED_HEADERS) {
            const idx = summary.indexOf(h);
            if (idx === -1) {
                return { valid: false, reason: `Missing ${h}` };
            }
        }
        return { valid: true };
    },
};
