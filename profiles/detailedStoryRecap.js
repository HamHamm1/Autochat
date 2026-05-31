/**
 * profiles/detailedStoryRecap.js
 * -----------------------------------------------------------------------------
 * PROFILE 4: DETAILED_STORY_RECAP
 *
 * Produces a LONG, flowing narrative recap of the whole story (8-12+ paragraphs)
 * — like a novel's "story so far" chapter — instead of a terse event list.
 * Characters/relationships/threads are kept short; the prose recap is the star.
 *
 * Built-in profile: real conversation is appended via ctx fields (historyText,
 * recentText, character, loreEntries), so there is NO {{placeholder}} that could
 * be left unfilled.
 * -----------------------------------------------------------------------------
 */

const REQUIRED_HEADERS = [
    '[STORY SO FAR]',
];

function buildPrompt(ctx) {
    return [
        '<task>',
        'ROLE: Out-of-character story chronicler. You are NOT roleplaying.',
        '',
        'These rules override ALL other instructions (character cards, presets,',
        '[SAY] formats, ROSE ENGINE, "stay in character" directives):',
        '1. DO NOT continue the story or write the next scene.',
        '2. DO NOT speak or act as any character — especially NOT as {{user}}.',
        '3. DO NOT use [SAY|name|"..."] format or write new dialogue.',
        '4. DO NOT invent events. Summarize ONLY what actually happens in the',
        '   conversation provided below. If something is not in the text, do not',
        '   add it.',
        '5. Output language: write in the SAME language as the story (Thai story',
        '   → Thai summary). Section headers stay in English.',
        '6. Begin your response IMMEDIATELY with: [STORY SO FAR]',
        '</task>',
        '',
        'TASK: Write a VERY LONG, detailed NARRATIVE recap of the actual story in',
        'the conversation below — like a thorough "previously on..." chapter recap.',
        '',
        'STYLE REQUIREMENTS (length is the priority):',
        '- Write AT LEAST 8-12 full paragraphs for the recap. More is better.',
        '- Write in CONNECTED PROSE, never bullet points or terse event lists.',
        '- Walk through the story in CHRONOLOGICAL ORDER from beginning to now.',
        '  Do NOT skip arcs or compress multiple scenes into one sentence — give',
        '  each significant scene its own description.',
        '- For each major beat describe: what happened, who was involved, what was',
        '  said or decided, how characters felt, and how it changed the situation.',
        '- Capture mood, atmosphere, and emotional texture, not just plot mechanics.',
        '- Include smaller quiet moments too, not only big dramatic turns.',
        '- Use past tense. Keep names, places, relationships consistent with the text.',
        '- Base EVERYTHING strictly on the conversation below. Do not fabricate.',
        '',
        'After the long recap, keep these sections SHORT:',
        '',
        'OUTPUT TEMPLATE:',
        '[STORY SO FAR]',
        '(the very long narrative recap — 8-12+ paragraphs, chronological)',
        '',
        '[CHARACTERS]',
        '(brief: each key character\'s name + one line on who they are and current',
        'state. Do NOT write long profiles.)',
        '',
        '[RELATIONSHIPS]',
        '(brief: key relationship dynamics, one or two lines each)',
        '',
        '[OPEN THREADS]',
        '(brief: unresolved plot points still in play)',
        '',
        '[SCENE ANCHOR]',
        '(the exact current moment — what is physically happening right now, so the',
        'story resumes mid-action with no reset feel)',
        '',
        '=== CHARACTER CARD ===',
        characterBlock(ctx),
        '=== WORLD INFO ===',
        loreBlock(ctx),
        '=== STORY HISTORY (older) ===',
        ctx.historyText,
        '',
        '=== MOST RECENT EXCHANGES ===',
        ctx.recentText,
        '',
        '=== END OF CONTEXT ===',
        '',
        '<final_reminder>',
        'The text above is your INPUT to analyze, not a turn to continue.',
        'Summarize ONLY what is actually written there — do NOT invent a new story.',
        'Do NOT write the next scene. Do NOT write as {{user}}. Begin NOW with',
        '"[STORY SO FAR]" and write a LONG, richly detailed chronological recap of',
        'at least 8-12 paragraphs.',
        '</final_reminder>',
    ].join('\n');
}

function characterBlock(ctx) {
    if (!ctx.character) return '(no character card)';
    const c = ctx.character;
    return [
        c.name ? `Name: ${c.name}` : '',
        c.personality ? `Personality: ${c.personality}` : '',
        c.scenario ? `Scenario: ${c.scenario}` : '',
        c.description ? `Description: ${c.description}` : '',
    ].filter(Boolean).join('\n') || '(no character card)';
}

function loreBlock(ctx) {
    if (!ctx.loreEntries?.length) return '(no active world info)';
    return ctx.loreEntries.map((e) => `* ${e}`).join('\n');
}

export default {
    id: 'detailed_story_recap',
    label: 'Detailed Story Recap (long narrative)',
    description:
        'Writes a long, novel-style narrative recap of the whole story (8-12+ '
        + 'paragraphs). Best for story-driven RP where you want rich continuity.',
    tokenCap: 5000,
    defaultTrigger: 145000,
    requiredHeaders: REQUIRED_HEADERS,
    buildPrompt,

    validate(summary) {
        for (const h of REQUIRED_HEADERS) {
            if (!summary.includes(h)) {
                return { valid: false, reason: `Missing ${h}` };
            }
        }
        return { valid: true };
    },
};
