/**
 * profiles/registry.js
 * -----------------------------------------------------------------------------
 * Modular prompt-profile registry.
 *
 * Built-in profiles are imported statically. Custom profiles live in storage
 * and are materialised on demand via makeCustomProfile(). To add a future
 * built-in profile, drop a `/profiles/*.js` file that default-exports a profile
 * object and register it in BUILTINS below — the core engine never changes.
 * -----------------------------------------------------------------------------
 */

import ocCanonCompact from './ocCanonCompact.js';
import animeStorySummaryV17 from './animeStorySummaryV17.js';
import detailedStoryRecap from './detailedStoryRecap.js';
import { makeCustomProfile } from './customTemplate.js';
import { getCustomProfiles } from '../lib/storage.js';

/** Static built-in profiles, keyed by id. */
const BUILTINS = {
    [ocCanonCompact.id]: ocCanonCompact,
    [animeStorySummaryV17.id]: animeStorySummaryV17,
    [detailedStoryRecap.id]: detailedStoryRecap,
};

export const CUSTOM_SELECTOR_ID = 'custom_template';

/** Return an array describing every selectable profile for the dropdown. */
export function listProfiles() {
    const items = Object.values(BUILTINS).map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        builtin: true,
    }));

    // The generic "Custom Template" selector entry.
    items.push({
        id: CUSTOM_SELECTOR_ID,
        label: 'Custom Template',
        description: 'User-defined summarization prompt.',
        builtin: false,
    });

    // Plus any concrete saved custom profiles.
    const customs = getCustomProfiles();
    for (const data of Object.values(customs)) {
        items.push({
            id: data.id,
            label: `Custom: ${data.label || data.id}`,
            description: data.description || 'User-defined summarization prompt.',
            builtin: false,
            isConcreteCustom: true,
        });
    }
    return items;
}

/**
 * Resolve a profile id to a runnable profile object.
 * Falls back to OC Canon Compact if the id is unknown.
 */
export function getProfile(id) {
    if (BUILTINS[id]) return BUILTINS[id];

    // Concrete saved custom profile?
    const customs = getCustomProfiles();
    if (customs[id]) return makeCustomProfile(customs[id]);

    // The bare "custom_template" selector with no concrete profile yet:
    // build an ephemeral default so a dry-run still works.
    if (id === CUSTOM_SELECTOR_ID) {
        return makeCustomProfile({ id: CUSTOM_SELECTOR_ID, label: 'Custom Template' });
    }

    // Unknown -> documented fallback.
    return BUILTINS[ocCanonCompact.id];
}

export function getFallbackProfile() {
    return BUILTINS[ocCanonCompact.id];
}

/**
 * Heuristic: does this character look anime/lore-heavy enough that we should
 * SUGGEST (never auto-switch) the v17 profile?
 */
export function suggestsAnimeProfile(character) {
    if (!character) return false;
    const hay = [
        character.name, character.personality, character.scenario,
        character.description, character.mesExample,
    ].filter(Boolean).join(' ').toLowerCase();

    const markers = [
        'anime', 'manga', 'senpai', 'chan', 'kun', 'sama', 'sensei',
        'academy', 'guild', 'quirk', 'nen', 'chakra', 'isekai', 'shonen',
        'lorebook', 'canon',
    ];
    let hits = 0;
    for (const m of markers) if (hay.includes(m)) hits++;
    return hits >= 2;
}
