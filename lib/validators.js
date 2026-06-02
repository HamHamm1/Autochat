/**
 * validators.js
 * -----------------------------------------------------------------------------
 * Corruption detection + structural validation for generated summaries.
 *
 * A rollover is ATOMIC: we never mutate the live chat unless the generated
 * summary passes validation here. Each profile supplies its own required
 * headers and token cap; these functions enforce them generically.
 * -----------------------------------------------------------------------------
 */

/**
 * Validate a generated summary string against a profile schema.
 *
 * @param {string} summary        - raw model output
 * @param {object} profile        - the active profile definition
 * @param {function} countTokens  - async (text) => number
 * @returns {Promise<{valid: boolean, reason?: string, tokenCount?: number}>}
 */
export async function validateSummary(summary, profile, countTokens) {
    // 1. Non-empty / not whitespace.
    if (typeof summary !== 'string' || summary.trim().length === 0) {
        return { valid: false, reason: 'Summary is empty.' };
    }

    // 2. Reject obvious refusal / error echoes that sometimes come back from a
    //    failed generation instead of a real summary.
    const lowered = summary.toLowerCase();
    const refusalMarkers = [
        'i cannot', 'i can not', 'as an ai', 'i\'m unable', 'i am unable',
    ];
    // Only treat as refusal if it's short AND contains a marker — a long valid
    // summary may legitimately contain such phrases inside quoted dialogue.
    if (summary.trim().length < 200 && refusalMarkers.some((m) => lowered.includes(m))) {
        return { valid: false, reason: 'Summary looks like a refusal/error response.' };
    }

    // 3. Required structural headers present.
    const requiredHeaders = profile?.requiredHeaders || [];
    const missing = requiredHeaders.filter((h) => !summary.includes(h));
    if (missing.length > 0) {
        return {
            valid: false,
            reason: `Missing required section(s): ${missing.join(', ')}`,
        };
    }

    // 4. Profile-specific structural validator (optional).
    if (typeof profile?.validate === 'function') {
        const res = profile.validate(summary);
        if (res && res.valid === false) {
            return { valid: false, reason: res.reason || 'Profile validator rejected output.' };
        }
    }

    // 5. Token cap. We allow a small grace margin (10%) because tokenizers vary
    //    slightly between count and actual injection, but anything wildly over
    //    is rejected.
    const cap = profile?.tokenCap || 2000;
    let tokenCount = 0;
    try {
        tokenCount = await countTokens(summary);
    } catch {
        // If counting fails, fall back to a rough char/4 heuristic rather than
        // aborting the whole rollover on a tooling hiccup.
        tokenCount = Math.ceil(summary.length / 4);
    }
    if (tokenCount > cap * 1.1) {
        return {
            valid: false,
            reason: `Summary too large: ${tokenCount} tokens (cap ${cap}).`,
            tokenCount,
        };
    }

    return { valid: true, tokenCount };
}

/**
 * Sanity-check a snapshot object before we trust it for rollback.
 */
export function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (!Array.isArray(snapshot.removedMessages) && !Array.isArray(snapshot.fullChat)) {
        return false;
    }
    if (typeof snapshot.id !== 'string') return false;
    return true;
}

/**
 * Validate an imported snapshot/profile JSON blob shape before merging it in.
 */
export function validateImportPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { valid: false, reason: 'Not an object.' };
    }
    if (payload.type !== 'st_acr_snapshot' && payload.type !== 'st_acr_profile') {
        return { valid: false, reason: 'Unknown payload type.' };
    }
    return { valid: true };
}
