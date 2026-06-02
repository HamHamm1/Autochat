/**
 * storage.js
 * -----------------------------------------------------------------------------
 * Persistence layer for the Auto Context Rollover extension.
 *
 * All settings, snapshots and rollover metadata are stored inside SillyTavern's
 * native `extension_settings` object, which is serialized to the user's settings
 * file and survives restarts. We deliberately do NOT use raw localStorage,
 * because extension_settings is the supported, sync-safe persistence surface and
 * is namespaced per-install.
 *
 * Storage shape (under extension_settings[MODULE_NAME]):
 * {
 *   config: { ...global config... },
 *   perChat:      { [chatId]: { profileId } },
 *   perCharacter: { [characterKey]: { profileId } },
 *   customProfiles: { [id]: {...profile def...} },
 *   snapshots:   [ { id, ts, chatId, ... } ],   // rollback + archive buffer
 *   lastRollover: { ts, profileId, chatId, tokensBefore, tokensAfter } | null
 * }
 * -----------------------------------------------------------------------------
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

export const MODULE_NAME = 'st_auto_context_rollover';

/**
 * Default global configuration. Every field here is user-tunable from the
 * settings panel. Ranges are enforced by the UI sliders and re-validated here.
 */
export const DEFAULT_CONFIG = Object.freeze({
    enabled: true,

    // Token watcher
    triggerThreshold: 80000,    // tokens; configurable 40000-190000
    maxModelContext: 200000,    // best-effort; refreshed from context if available

    // Summarizer
    summaryMaxTokens: 2000,     // 500-4000
    retainedMessageCount: 24,   // 4-50

    // Mode: 'silent' | 'notify' | 'confirm' | 'debug'
    mode: 'notify',

    // Behavior
    archiveTrimmed: true,       // store removed messages as compressed snapshots
    cooldownSeconds: 120,       // anti-spam between auto rollovers

    // Opt-in literal preset Main Prompt mutation (default OFF; injection is the
    // safe, reversible path — see rolloverEngine design note). Only honored if
    // the running ST build exposes a public setter.
    overwriteMainPrompt: false,

    // Profile selection (global default; may be overridden per-chat/character)
    profileId: 'oc_canon_compact',

    // Anime Story Summary v17 advanced sub-options
    animeV17: {
        modeAEnabled: true,
        modeBEnabled: true,
        autonomousSnapshotThreshold: 140000,
        eventSealTriggerCount: 12,
        antiRetconRepair: true,
    },
});

/**
 * Lazily initialise and return the root storage object for this module.
 * Guarantees every expected key exists so callers never hit `undefined`.
 */
export function getStore() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const store = extension_settings[MODULE_NAME];

    if (!store.config) store.config = structuredClone(DEFAULT_CONFIG);
    // Backfill any newly-added default keys after an upgrade.
    store.config = { ...structuredClone(DEFAULT_CONFIG), ...store.config };
    if (!store.config.animeV17) {
        store.config.animeV17 = structuredClone(DEFAULT_CONFIG.animeV17);
    } else {
        store.config.animeV17 = {
            ...structuredClone(DEFAULT_CONFIG.animeV17),
            ...store.config.animeV17,
        };
    }

    if (!store.perChat) store.perChat = {};
    if (!store.perCharacter) store.perCharacter = {};
    if (!store.customProfiles) store.customProfiles = {};
    if (!Array.isArray(store.snapshots)) store.snapshots = [];
    if (store.lastRollover === undefined) store.lastRollover = null;

    return store;
}

/** Persist all changes. Debounced by SillyTavern to avoid disk thrash. */
export function persist() {
    saveSettingsDebounced();
}

/* --------------------------- Config accessors --------------------------- */

export function getConfig() {
    return getStore().config;
}

/**
 * Apply a partial config patch, clamping numeric values to their valid ranges,
 * then persist. Returns the updated config.
 */
export function updateConfig(patch) {
    const store = getStore();
    const cfg = store.config;

    if (patch.triggerThreshold !== undefined) {
        cfg.triggerThreshold = clamp(patch.triggerThreshold, 40000, 190000);
    }
    if (patch.summaryMaxTokens !== undefined) {
        cfg.summaryMaxTokens = clamp(patch.summaryMaxTokens, 500, 4000);
    }
    if (patch.retainedMessageCount !== undefined) {
        cfg.retainedMessageCount = clamp(patch.retainedMessageCount, 4, 50);
    }
    if (patch.cooldownSeconds !== undefined) {
        cfg.cooldownSeconds = clamp(patch.cooldownSeconds, 0, 3600);
    }
    if (patch.mode !== undefined) cfg.mode = patch.mode;
    if (patch.enabled !== undefined) cfg.enabled = !!patch.enabled;
    if (patch.archiveTrimmed !== undefined) cfg.archiveTrimmed = !!patch.archiveTrimmed;
    if (patch.overwriteMainPrompt !== undefined) cfg.overwriteMainPrompt = !!patch.overwriteMainPrompt;
    if (patch.profileId !== undefined) cfg.profileId = patch.profileId;
    if (patch.maxModelContext !== undefined && patch.maxModelContext > 0) {
        cfg.maxModelContext = patch.maxModelContext;
    }
    if (patch.animeV17 !== undefined) {
        cfg.animeV17 = { ...cfg.animeV17, ...patch.animeV17 };
        cfg.animeV17.autonomousSnapshotThreshold = clamp(
            cfg.animeV17.autonomousSnapshotThreshold, 40000, 190000,
        );
        cfg.animeV17.eventSealTriggerCount = clamp(
            cfg.animeV17.eventSealTriggerCount, 1, 100,
        );
    }

    persist();
    return cfg;
}

/* ------------------------- Profile scope resolution ------------------------- */

/**
 * Resolve the effective profile id following the documented priority:
 *   Character override -> Chat override -> Global default.
 * Any of chatId / characterKey may be null/undefined.
 */
export function resolveProfileId(chatId, characterKey) {
    const store = getStore();
    if (characterKey && store.perCharacter[characterKey]?.profileId) {
        return store.perCharacter[characterKey].profileId;
    }
    if (chatId && store.perChat[chatId]?.profileId) {
        return store.perChat[chatId].profileId;
    }
    return store.config.profileId || DEFAULT_CONFIG.profileId;
}

/** Save a profile selection at the requested scope. */
export function setProfileScope({ scope, profileId, chatId, characterKey }) {
    const store = getStore();
    switch (scope) {
        case 'character':
            if (!characterKey) return false;
            store.perCharacter[characterKey] = { profileId };
            break;
        case 'chat':
            if (!chatId) return false;
            store.perChat[chatId] = { profileId };
            break;
        case 'global':
        default:
            store.config.profileId = profileId;
            break;
    }
    persist();
    return true;
}

/* ----------------------------- Custom profiles ----------------------------- */

export function getCustomProfiles() {
    return getStore().customProfiles;
}

export function saveCustomProfile(profile) {
    if (!profile?.id) throw new Error('Custom profile requires an id');
    getStore().customProfiles[profile.id] = profile;
    persist();
}

export function deleteCustomProfile(id) {
    delete getStore().customProfiles[id];
    persist();
}

/* -------------------------------- Snapshots -------------------------------- */

const MAX_SNAPSHOTS = 10; // hard ceiling so settings file never balloons

/**
 * Push a snapshot onto the ring buffer. Newest first. Oldest evicted past cap.
 * A snapshot captures enough to fully restore the pre-rollover chat state.
 */
export function pushSnapshot(snapshot) {
    const store = getStore();
    store.snapshots.unshift(snapshot);
    if (store.snapshots.length > MAX_SNAPSHOTS) {
        store.snapshots.length = MAX_SNAPSHOTS;
    }
    persist();
}

export function getSnapshots() {
    return getStore().snapshots;
}

export function getLatestSnapshot() {
    return getStore().snapshots[0] || null;
}

export function removeSnapshot(id) {
    const store = getStore();
    store.snapshots = store.snapshots.filter((s) => s.id !== id);
    persist();
}

export function clearSnapshots() {
    getStore().snapshots = [];
    persist();
}

/** Generate an RFC4122-ish UUID v4 (used for the chat integrity field). */
function makeUuid() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch { /* fall through */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Convert a snapshot's full chat into SillyTavern's native .jsonl chat format,
 * so the exported file can be re-imported as a fresh chat in SillyTavern.
 *
 * Format (one JSON object per line):
 *   line 1: { user_name, character_name, chat_metadata }
 *   line 2+: one message object each (name, is_user, is_system, send_date,
 *            mes, extra, swipe_id, swipes, swipe_info, ...)
 *
 * We reconstruct from snapshot.fullChat (the exact pre-rollover messages). If a
 * message already has the native fields we keep them; otherwise we synthesize
 * sane defaults so SillyTavern accepts the import.
 *
 * @param {object} snapshot
 * @param {object} [meta] - { user_name, character_name } overrides
 * @returns {string} jsonl text
 */
export function snapshotToJsonl(snapshot, meta = {}) {
    const chat = Array.isArray(snapshot?.fullChat) ? snapshot.fullChat : [];

    // Derive names: prefer explicit meta, then the snapshot, then first messages.
    const charName = meta.character_name
        || snapshot?.characterKey
        || chat.find((m) => m && m.is_user === false)?.name
        || 'Character';
    const userName = meta.user_name
        || chat.find((m) => m && m.is_user === true)?.name
        || 'User';

    // Build chat_metadata that SillyTavern (incl. iOS builds) will accept.
    // iOS validates the chat file and REQUIRES an `integrity` UUID plus the
    // standard Author's-Note fields. If these are missing the import silently
    // fails on iOS (Android is more lenient). We merge any captured metadata on
    // top of a complete default skeleton so the file imports on BOTH platforms.
    const baseMeta = {
        integrity: makeUuid(),
        note_prompt: '',
        note_interval: 1,
        note_position: 1,
        note_depth: 4,
        note_role: 0,
        timedWorldInfo: { sticky: {}, cooldown: {} },
        tainted: true,
        lastInContextMessageId: 0,
    };
    const chatMeta = { ...baseMeta, ...(snapshot?.chatMetadata || {}) };
    // Always force a fresh integrity UUID (a stale/duplicate one can be rejected).
    chatMeta.integrity = makeUuid();

    const header = {
        user_name: userName,
        character_name: charName,
        chat_metadata: chatMeta,
    };

    const lines = [JSON.stringify(header)];

    for (const m of chat) {
        if (!m || typeof m !== 'object') continue;
        const mes = typeof m.mes === 'string' ? m.mes : String(m.mes ?? '');
        const sendDate = m.send_date || new Date().toISOString();
        const obj = {
            name: m.name || (m.is_user ? userName : charName),
            is_user: !!m.is_user,
            is_system: !!m.is_system,
            send_date: sendDate,
            mes,
            extra: m.extra || {},
            swipe_id: typeof m.swipe_id === 'number' ? m.swipe_id : 0,
            swipes: Array.isArray(m.swipes) ? m.swipes : [mes],
            swipe_info: Array.isArray(m.swipe_info)
                ? m.swipe_info
                : [{ send_date: sendDate, extra: {} }],
        };
        lines.push(JSON.stringify(obj));
    }

    return lines.join('\n');
}

/**
 * Build a .jsonl that also injects the canonical-memory summary as the FIRST
 * assistant message, so a re-imported chat starts with the story memory intact.
 * Useful as a recovery file: import it and the bot already "remembers".
 */
export function snapshotToJsonlWithSummary(snapshot, meta = {}) {
    const base = snapshotToJsonl(snapshot, meta);
    if (!snapshot?.summary) return base;

    const lines = base.split('\n');
    const header = lines[0];
    const rest = lines.slice(1);

    const now = new Date().toISOString();
    const charName = JSON.parse(header).character_name || 'Character';
    const summaryMsg = {
        name: charName,
        is_user: false,
        is_system: true, // mark as system so it's visually distinct
        send_date: now,
        mes: `[CANONICAL MEMORY — restored from snapshot]\n${snapshot.summary}`,
        extra: {},
        swipe_id: 0,
        swipes: [`[CANONICAL MEMORY — restored from snapshot]\n${snapshot.summary}`],
        swipe_info: [{ send_date: now, extra: {} }],
    };

    return [header, JSON.stringify(summaryMsg), ...rest].join('\n');
}

export function setLastRollover(meta) {
    getStore().lastRollover = meta;
    persist();
}

export function getLastRollover() {
    return getStore().lastRollover;
}

/* --------------------------------- Helpers --------------------------------- */

export function clamp(n, min, max) {
    n = Number(n);
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
}
