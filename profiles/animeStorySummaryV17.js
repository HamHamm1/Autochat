/**
 * profiles/animeStorySummaryV17.js
 * -----------------------------------------------------------------------------
 * PROFILE 2: ANIME_STORY_SUMMARY_V17
 *
 * Full multi-phase canonical summary for anime/lore-heavy, canon-driven bots.
 * Implements the [STORY SUMMARY SYSTEM v17] template with its five phases and
 * a re-emitted <CANON_STATE> block used for anti-retcon continuity repair.
 * -----------------------------------------------------------------------------
 */

const REQUIRED_HEADERS = [
    '[STORY SUMMARY SYSTEM v17]',
    'PHASE 1: CHARACTER CARD SCAN',
    'PHASE 2: LOREBOOK INVENTORY',
    'PHASE 3: CHRONOLOGICAL EVENT LOG',
    'PHASE 4: CONTINUITY ANCHOR',
    'PHASE 5: <CANON_STATE>',
    '<CANON_STATE>',
    '</CANON_STATE>',
];

/**
 * @param {object} ctx     - assembled runtime context
 * @param {object} options - { animeV17 sub-config, mode: 'A'|'B' }
 */
function buildPrompt(ctx, options = {}) {
    const v = options.animeV17 || {};
    const mode = options.mode || 'B'; // B = autonomous snapshot (default for auto rollover)
    const antiRetcon = v.antiRetconRepair !== false;
    const sealCount = v.eventSealTriggerCount || 12;

    return [
        '<task>',
        'ROLE: Out-of-character canonical story-ledger analyst (NOT a roleplay',
        'participant).',
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
        '       [STORY SUMMARY SYSTEM v17]',
        '   If your first characters are anything else, the task has failed.',
        '6. Output language: write the summary in the SAME language the story is',
        '   in (Thai story → Thai summary). Keep PHASE/section headers in English.',
        '',
        'TASK: Read the conversation history below and produce a five-phase',
        'canonical ledger using the exact template. This is a meta-analysis task,',
        'not a story turn. Think of yourself as a chronicler filing canon records.',
        '</task>',
        '',
        '[STORY SUMMARY SYSTEM v17]',
        '',
        'You are a canonical story-ledger engine for an anime/lore-driven roleplay.',
        `ACTIVATION MODE: ${mode === 'A' ? 'MODE A (USER-TRIGGERED)' : 'MODE B (AUTONOMOUS SNAPSHOT)'}`,
        'Reconstruct the complete canonical state by executing all five phases in',
        'order. Output the phases as labeled sections, then re-emit <CANON_STATE>.',
        '',
        'GLOBAL RULES:',
        '- You are OUT OF CHARACTER. Write as an analyst, not as any persona.',
        '- Preserve COMPLETE canonical continuity. Never invent facts not in context.',
        '- Never retcon established events. If two sources conflict, prefer the most',
        '  recent in-chat event and note the resolution inside PHASE 4.',
        `- Seal at least ${sealCount} most-significant events into the chronological log.`,
        antiRetcon
            ? '- ANTI-RETCON REPAIR is ON: explicitly reconcile any continuity drift.'
            : '- Anti-retcon repair is OFF: log events as-is without reconciliation.',
        '- Output ONLY the template. No commentary, no story, no dialogue.',
        '',
        '=== PHASE INSTRUCTIONS ===',
        '',
        'PHASE 1: CHARACTER CARD SCAN',
        '  Extract canonical traits from the character card: identity, personality,',
        '  powers/abilities, speech style, relationships defined on the card.',
        '',
        'PHASE 2: LOREBOOK INVENTORY',
        '  Inventory every active world-info / lorebook fact relevant to current canon.',
        '  List as discrete entries so they can be re-injected losslessly.',
        '',
        'PHASE 3: CHRONOLOGICAL EVENT LOG',
        '  Reconstruct events in strict order. Number them. Mark sealed canon events.',
        '',
        'PHASE 4: CONTINUITY ANCHOR',
        '  Pin the exact present-moment scene: location, who is present, immediate',
        '  action, unresolved tension. This is the resume point.',
        '',
        'PHASE 5: <CANON_STATE> RE-EMIT',
        '  Emit a compact machine-reusable block between <CANON_STATE> and',
        '  </CANON_STATE> capturing: arc, relationships, sealed events, open threads,',
        '  emotional state, and the scene anchor. This block is the migration payload.',
        '',
        'OUTPUT NOW, filling each phase:',
        '',
        'PHASE 1: CHARACTER CARD SCAN',
        '',
        'PHASE 2: LOREBOOK INVENTORY',
        '',
        'PHASE 3: CHRONOLOGICAL EVENT LOG',
        '',
        'PHASE 4: CONTINUITY ANCHOR',
        '',
        'PHASE 5: <CANON_STATE>',
        '<CANON_STATE>',
        '(compact canonical payload here)',
        '</CANON_STATE>',
        '',
        '=== CONTEXT ===',
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
        '[STORY SUMMARY SYSTEM v17]',
        '',
        'and fill in every PHASE section plus a <CANON_STATE>...</CANON_STATE>',
        'block. If your first characters are anything else (a name, a quote, a',
        'narration), you have failed the task.',
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
        '--- ACTIVE WORLD INFO / LOREBOOK ---',
        ctx.loreEntries.map((e, i) => `[L${i + 1}] ${e}`).join('\n'),
        '',
    ].join('\n');
}

export default {
    id: 'anime_story_summary_v17',
    label: 'Anime Story Summary v17',
    description:
        'Uses full multi-phase canonical summary including character card scan, lorebook '
        + 'inventory, chronological event reconstruction, continuity anchor, and CANON_STATE '
        + 'regeneration.',
    // This profile legitimately needs more room than the compact one.
    tokenCap: 3500,
    defaultTrigger: 140000,
    requiredHeaders: REQUIRED_HEADERS,
    buildPrompt,

    /** The <CANON_STATE> block must be present and non-empty. */
    validate(summary) {
        const open = summary.indexOf('<CANON_STATE>');
        const close = summary.indexOf('</CANON_STATE>');
        if (open === -1 || close === -1 || close <= open) {
            return { valid: false, reason: 'Malformed or missing <CANON_STATE> block.' };
        }
        const inner = summary.slice(open + '<CANON_STATE>'.length, close).trim();
        if (inner.length < 20) {
            return { valid: false, reason: '<CANON_STATE> payload too small.' };
        }
        return { valid: true };
    },
};
