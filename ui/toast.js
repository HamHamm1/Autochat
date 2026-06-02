/**
 * ui/toast.js
 * -----------------------------------------------------------------------------
 * Thin wrapper over SillyTavern's bundled toastr, with a console fallback so
 * the extension never crashes if toastr isn't present.
 * -----------------------------------------------------------------------------
 */

export function toast(message, level = 'info') {
    const t = globalThis.toastr;
    if (t && typeof t[level] === 'function') {
        t[level](message, 'Auto Context Rollover', { timeOut: 4000 });
        return;
    }
    if (t && typeof t.info === 'function') {
        t.info(message, 'Auto Context Rollover');
        return;
    }
    // Fallback.
    // eslint-disable-next-line no-console
    console.log(`[ACR:${level}] ${message}`);
}

/**
 * Lightweight confirm dialog. Prefers ST's callPopup/Popup, falls back to the
 * native confirm() so "Confirm" mode always works.
 * @returns {Promise<boolean>}
 */
export async function confirmDialog(message) {
    const ctx = globalThis.SillyTavern?.getContext?.();
    try {
        if (ctx?.Popup?.show?.confirm) {
            const result = await ctx.Popup.show.confirm('Auto Context Rollover', message);
            return !!result;
        }
        if (typeof ctx?.callPopup === 'function') {
            const result = await ctx.callPopup(message, 'confirm');
            return !!result;
        }
    } catch {
        /* fall through */
    }
    // eslint-disable-next-line no-alert
    return Promise.resolve(globalThis.confirm ? globalThis.confirm(message) : true);
}

/**
 * Show arbitrary text content in a modal (used for the dry-run preview).
 */
export async function showTextModal(title, text) {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const safe = String(text || '');
    try {
        if (ctx?.Popup) {
            const html = `<h3>${escapeHtml(title)}</h3>`
                + `<textarea readonly rows="20" style="width:100%;font-family:monospace;">`
                + `${escapeHtml(safe)}</textarea>`;
            // Popup type 1 == TEXT in ST's enum on most builds.
            await ctx.Popup.show?.text?.(html) ?? ctx.callPopup?.(html, 'text');
            return;
        }
        if (typeof ctx?.callPopup === 'function') {
            await ctx.callPopup(
                `<h3>${escapeHtml(title)}</h3><pre style="white-space:pre-wrap;max-height:60vh;overflow:auto;">${escapeHtml(safe)}</pre>`,
                'text',
            );
            return;
        }
    } catch {
        /* fall through */
    }
    // eslint-disable-next-line no-alert
    if (globalThis.alert) globalThis.alert(`${title}\n\n${safe}`);
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}
