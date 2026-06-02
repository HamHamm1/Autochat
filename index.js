/**
 * index.js
 * -----------------------------------------------------------------------------
 * Entry point for the Auto Context Rollover SillyTavern extension.
 *
 * Wiring:
 *   - Acquire the ST context via SillyTavern.getContext().
 *   - Build TokenMonitor, RolloverEngine, settings UI, quick-switch.
 *   - Subscribe to the context-changing events to drive debounced recounts.
 *   - Register slash commands for power users.
 *
 * Everything degrades gracefully: if an expected API is missing we log and
 * continue rather than throwing during ST startup.
 * -----------------------------------------------------------------------------
 */

import { getConfig } from './lib/storage.js';
import { TokenMonitor } from './lib/tokenMonitor.js';
import { RolloverEngine } from './lib/rolloverEngine.js';
import { buildSettingsPanel } from './ui/settingsPanel.js';
import { toast, confirmDialog } from './ui/toast.js';

const LOG_PREFIX = '[Auto-Context-Rollover]';

/** Leveled logger. In debug mode, everything prints; otherwise info+ only. */
function makeLogger() {
    return (level, ...args) => {
        const cfg = safeConfig();
        const verbose = cfg?.mode === 'debug';
        if (level === 'debug' && !verbose) return;
        const fn = level === 'error' ? console.error
            : level === 'warn' ? console.warn
                : console.log;
        fn(LOG_PREFIX, ...args);
    };
}

function safeConfig() {
    try { return getConfig(); } catch { return null; }
}

/** Resolve the ST context with a couple of fallbacks across versions. */
function acquireContext() {
    if (globalThis.SillyTavern?.getContext) return globalThis.SillyTavern.getContext();
    if (typeof globalThis.getContext === 'function') return globalThis.getContext();
    return null;
}

(function init() {
    const log = makeLogger();
    const context = acquireContext();

    if (!context) {
        console.error(`${LOG_PREFIX} Could not acquire SillyTavern context. Extension inactive.`);
        return;
    }

    log('info', 'Initializing…');

    // --- Token monitor ------------------------------------------------------
    const tokenMonitor = new TokenMonitor({
        context,
        log,
        onThreshold: async (info) => {
            try {
                await engine.autoRollover(info);
            } catch (e) {
                log('error', 'autoRollover failed:', e);
            }
        },
        // Repaint the panel after every recount (repaint only — do NOT recount
        // again here, or we'd loop). Keeps the token display live while chatting.
        onUpdate: () => {
            panel?.refreshStatus?.({ recount: false });
        },
    });

    // --- Rollover engine ----------------------------------------------------
    const engine = new RolloverEngine({
        context,
        tokenMonitor,
        log,
        ui: {
            toast,
            confirm: confirmDialog,
            status: () => panel?.refreshStatus?.(),
        },
    });

    // --- UI -----------------------------------------------------------------
    let panel = null;

    function refreshAllProfileUI() {
        panel?.refreshProfileSelect?.();
    }

    function mountUI() {
        try {
            panel = buildSettingsPanel({
                engine, tokenMonitor, getContext: acquireContext, log,
                onProfileChange: refreshAllProfileUI,
            });
        } catch (e) {
            log('error', 'Failed to build settings panel:', e);
        }
    }

    // --- Event subscriptions ------------------------------------------------
    const ev = context.eventSource;
    const types = context.event_types || context.eventTypes || {};

    function on(typeName, handler) {
        const t = types[typeName];
        if (ev && t) {
            ev.on(t, handler);
            return true;
        }
        return false;
    }

    if (ev) {
        // Recount after anything that changes context size. `on()` returns true
        // only if the event name actually exists in this ST build; we tally how
        // many bound so we can warn if the names don't match this version.
        let bound = 0;
        bound += on('MESSAGE_RECEIVED', () => tokenMonitor.requestRecount('message_received')) ? 1 : 0;
        bound += on('MESSAGE_SENT', () => tokenMonitor.requestRecount('message_sent')) ? 1 : 0;
        bound += on('MESSAGE_SWIPED', () => tokenMonitor.requestRecount('message_swiped')) ? 1 : 0;
        bound += on('MESSAGE_DELETED', () => tokenMonitor.requestRecount('message_deleted')) ? 1 : 0;
        bound += on('MESSAGE_EDITED', () => tokenMonitor.requestRecount('message_edited')) ? 1 : 0;
        bound += on('GENERATION_ENDED', () => tokenMonitor.requestRecount('generation_ended')) ? 1 : 0;

        // Re-fill profile UI + recount when the chat or character changes.
        on('CHAT_CHANGED', () => {
            refreshAllProfileUI();
            panel?.refreshStatus?.();
            tokenMonitor.requestRecount('chat_changed');
        });
        on('CHARACTER_EDITED', refreshAllProfileUI);

        log('info', `Event hooks bound: ${bound} of 6 expected. ` +
            `(event_types ${types && Object.keys(types).length ? 'present' : 'MISSING'})`);

        // When the app is fully ready, mount UI and do an initial count.
        const mountedOnReady = on('APP_READY', () => {
            mountUI();
            tokenMonitor.requestRecount('app_ready');
        });
        if (!mountedOnReady) {
            // Older builds without APP_READY: mount on next tick.
            setTimeout(() => {
                mountUI();
                tokenMonitor.requestRecount('init_fallback');
            }, 1500);
        }
    } else {
        log('warn', 'eventSource unavailable; mounting UI on timer and relying on manual recount.');
        setTimeout(() => {
            mountUI();
            tokenMonitor.requestRecount('no_eventsource');
        }, 1500);
    }

    // --- Safety-net polling -------------------------------------------------
    // Regardless of whether event hooks bound correctly (event names vary
    // across ST versions), poll a recount on a slow interval. This guarantees
    // the token display and the auto-trigger keep working even if no event
    // fired. Cheap: the tokenizer only runs when chat actually changed size,
    // and recount() is internally guarded against overlap.
    let _lastPolledTokens = -1;
    setInterval(() => {
        const cfg = safeConfig();
        if (!cfg || !cfg.enabled) return;
        tokenMonitor.recount('poll').then(() => {
            const now = tokenMonitor.currentTokens;
            if (now !== _lastPolledTokens) {
                _lastPolledTokens = now;
                panel?.refreshStatus?.({ recount: false });
            }
        }).catch(() => { /* non-fatal */ });
    }, 5000);

    // --- Slash commands -----------------------------------------------------
    registerSlashCommands(context, engine, tokenMonitor, log);

    log('info', 'Ready.');
})();

/**
 * Register power-user slash commands using whichever registration API the
 * running ST build exposes. All commands are optional conveniences.
 */
function registerSlashCommands(context, engine, tokenMonitor, log) {
    const register = (name, callback, help) => {
        try {
            // Newer ST: SlashCommandParser + SlashCommand.fromProps
            const Parser = context.SlashCommandParser || globalThis.SlashCommandParser;
            const SlashCommand = context.SlashCommand || globalThis.SlashCommand;
            if (Parser?.addCommandObject && SlashCommand?.fromProps) {
                Parser.addCommandObject(SlashCommand.fromProps({
                    name,
                    callback: async () => { await callback(); return ''; },
                    helpString: help,
                }));
                return true;
            }
            // Older ST: registerSlashCommand(name, fn, aliases, help, ...)
            const legacy = context.registerSlashCommand || globalThis.registerSlashCommand;
            if (typeof legacy === 'function') {
                legacy(name, async () => { await callback(); return ''; }, [], help, true, true);
                return true;
            }
        } catch (e) {
            log('debug', `slash command ${name} registration failed:`, e?.message);
        }
        return false;
    };

    register('acr-rollover', () => engine.manualRollover(), 'Run an Auto Context Rollover now.');
    register('acr-rollback', () => engine.rollbackLast(), 'Undo the last Auto Context Rollover.');
    register('acr-recount', () => tokenMonitor.recount('slash'), 'Recount context tokens now.');
    register('acr-test', async () => {
        const { showTextModal } = await import('./ui/toast.js');
        const { profile, summary, validation } = await engine.dryRunPreview();
        await showTextModal('Summary Preview',
            `Profile: ${profile.label}\nValid: ${validation.valid}\n\n${summary}`);
    }, 'Dry-run the selected summary profile.');
}
