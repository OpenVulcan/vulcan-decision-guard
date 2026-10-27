/**
 * The plugin's look, after VulcanCode's ui-kit (`apps/vulcan-code-web/src/ui-kit/styles`): square
 * corners, hairline borders, numbered sections with an ember corner tick, tinted badges and plain
 * tables. Every rule is scoped under `.vdg`, so nothing leaks into dsh; dark values follow dsh's
 * `body[data-ds-dark-theme]`.
 */

const CSS = `
.vdg {
  --vk-u: 4px;
  --vk-panel: #fff; --vk-sunken: #f6f7f9; --vk-hover: #eef1f4; --vk-select: #e3e9f8;
  --vk-line: #dde1e6; --vk-line-strong: #c3c9d1; --vk-line-soft: #eaecef;
  --vk-ink: #14171c; --vk-ink-2: #4a515c; --vk-ink-3: #626973;
  --vk-ember: #e2511a; --vk-signal: #2e58cc; --vk-ok: #18774a; --vk-warn: #945d09; --vk-bad: #c3303d;
  --vk-shadow-1: 0 1px 2px rgba(20, 23, 28, 0.06);
  --vk-shadow-2: 0 16px 40px rgba(20, 23, 28, 0.18), 0 2px 8px rgba(20, 23, 28, 0.08);
  --vk-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px; line-height: 1.5; color: var(--vk-ink);
}
body[data-ds-dark-theme] .vdg {
  --vk-panel: #15181d; --vk-sunken: #0f1215; --vk-hover: #1e2329; --vk-select: #1c2537;
  --vk-line: #23282f; --vk-line-strong: #343b45; --vk-line-soft: #1a1e24;
  --vk-ink: #e6e9ed; --vk-ink-2: #a2aab5; --vk-ink-3: #848c97;
  --vk-ember: #ff6a2b; --vk-signal: #7d9dff; --vk-ok: #3fc48a; --vk-warn: #e0a83a; --vk-bad: #f0646f;
  --vk-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --vk-shadow-2: 0 16px 40px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
}
.vdg *, .vdg *::before, .vdg *::after { box-sizing: border-box; }
.vdg-page { display: flex; flex-direction: column; gap: calc(var(--vk-u) * 4); counter-reset: vdg-section; padding-bottom: calc(var(--vk-u) * 2); }
.vdg-page-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.vdg-lead { margin: calc(var(--vk-u) * 1) 0 0; color: var(--vk-ink-2); }
.vdg-hint { margin: 0; color: var(--vk-ink-3); font-size: 12px; }
.vdg-error { margin: 0; color: var(--vk-bad); font-size: 12px; overflow-wrap: anywhere; }
.vdg-warn { margin: 0; color: var(--vk-warn); font-size: 12px; }

.vdg-section { position: relative; border: 1px solid var(--vk-line); background: var(--vk-panel); box-shadow: var(--vk-shadow-1); }
.vdg-section::before { content: ""; position: absolute; left: -1px; top: -1px; width: calc(var(--vk-u) * 7); height: 2px; background: var(--vk-ember); }
.vdg-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: calc(var(--vk-u) * 3); padding: calc(var(--vk-u) * 3.5) calc(var(--vk-u) * 4) 0; }
.vdg-section-title { display: flex; align-items: center; gap: calc(var(--vk-u) * 2); margin: 0; font-size: 15px; font-weight: 600; }
.vdg-section-title::before { counter-increment: vdg-section; content: counter(vdg-section, decimal-leading-zero); border: 1px solid var(--vk-line); color: var(--vk-ink-3); font-family: var(--vk-mono); font-size: 10px; font-weight: 400; letter-spacing: .06em; padding: 0 5px; line-height: 16px; }
.vdg-section-lead { margin: calc(var(--vk-u) * 1) 0 0; color: var(--vk-ink-3); font-size: 12px; }
.vdg-section-body { display: flex; flex-direction: column; gap: calc(var(--vk-u) * 3); padding: calc(var(--vk-u) * 3) calc(var(--vk-u) * 4) calc(var(--vk-u) * 4); }
.vdg-section-body.flush { padding: calc(var(--vk-u) * 3) 0 0; gap: 0; }

.vdg-rows { display: flex; flex-direction: column; border-top: 1px solid var(--vk-line-soft); }
.vdg-row { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--vk-u) * 3); padding: calc(var(--vk-u) * 3) calc(var(--vk-u) * 4); border-bottom: 1px solid var(--vk-line-soft); }
.vdg-row:last-child { border-bottom: 0; }
.vdg-row-label { font-weight: 500; flex-shrink: 0; }
.vdg-row-value { display: flex; align-items: center; gap: calc(var(--vk-u) * 2); min-width: 0; color: var(--vk-ink-2); text-align: right; overflow-wrap: anywhere; }
.vdg-field { display: flex; flex-direction: column; gap: calc(var(--vk-u) * 1.5); }
.vdg-field > label, .vdg-label { color: var(--vk-ink-2); font-size: 12px; }
.vdg-inline { display: flex; align-items: center; gap: calc(var(--vk-u) * 2); flex-wrap: wrap; }
.vdg-between { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--vk-u) * 3); flex-wrap: wrap; }

.vdg-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: calc(var(--vk-u) * 2); }
.vdg-choice { display: flex; gap: calc(var(--vk-u) * 2.5); align-items: flex-start; padding: calc(var(--vk-u) * 3); border: 1px solid var(--vk-line); background: var(--vk-panel); cursor: pointer; text-align: left; color: inherit; font: inherit; }
.vdg-choice:hover { background: var(--vk-hover); }
.vdg-choice[aria-checked="true"] { border-color: var(--vk-ember); box-shadow: inset 2px 0 0 var(--vk-ember); background: var(--vk-sunken); }
.vdg-choice[aria-disabled="true"] { cursor: default; opacity: .6; }
.vdg-choice-mark { flex-shrink: 0; width: 12px; height: 12px; margin-top: 3px; border: 1px solid var(--vk-line-strong); border-radius: 50%; }
.vdg-choice[aria-checked="true"] .vdg-choice-mark { border: 4px solid var(--vk-ember); }
.vdg-choice-title { display: block; font-weight: 500; }
.vdg-choice-hint { display: block; margin-top: 2px; color: var(--vk-ink-3); font-size: 12px; }

.vdg-segments { display: inline-flex; border: 1px solid var(--vk-line-strong); }
.vdg-segment { height: 26px; padding: 0 calc(var(--vk-u) * 3); border: 0; border-right: 1px solid var(--vk-line-strong); background: var(--vk-panel); color: var(--vk-ink-2); font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.vdg-segment:last-child { border-right: 0; }
.vdg-segment[aria-pressed="true"] { background: var(--vk-ink); color: var(--vk-panel); }
.vdg-segment:disabled { cursor: default; opacity: .6; }

.vdg-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 calc(var(--vk-u) * 3); border: 1px solid var(--vk-line-strong); background: var(--vk-panel); color: var(--vk-ink); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; border-radius: 0; }
.vdg-btn:hover:not(:disabled) { background: var(--vk-hover); }
.vdg-btn:disabled { cursor: default; opacity: .55; }
.vdg-btn.sm { height: 24px; padding: 0 calc(var(--vk-u) * 2); }
.vdg-btn.primary { background: var(--vk-ink); border-color: var(--vk-ink); color: var(--vk-panel); }
.vdg-btn.primary:hover:not(:disabled) { background: var(--vk-ink-2); }
.vdg-btn.ghost { border-color: transparent; background: transparent; }
.vdg-btn.ghost:hover:not(:disabled) { background: var(--vk-hover); }
.vdg-link { border: 0; padding: 0; background: none; color: var(--vk-signal); font: inherit; font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }

.vdg-select, .vdg-input, .vdg-textarea { min-height: 28px; padding: 0 calc(var(--vk-u) * 2); border: 1px solid var(--vk-line-strong); border-radius: 0; background: var(--vk-panel); color: var(--vk-ink); font: inherit; }
.vdg-select { min-width: 220px; max-width: 100%; }
.vdg-textarea { width: 100%; padding: calc(var(--vk-u) * 2); resize: vertical; line-height: 1.5; }
.vdg-select:focus-visible, .vdg-input:focus-visible, .vdg-textarea:focus-visible, .vdg-btn:focus-visible, .vdg-choice:focus-visible, .vdg-segment:focus-visible { outline: 2px solid var(--vk-signal); outline-offset: 1px; }

.vdg-check { display: flex; align-items: flex-start; gap: calc(var(--vk-u) * 2.5); cursor: pointer; }
.vdg-check input { margin: 3px 0 0; accent-color: var(--vk-ember); }

.vdg-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--tone, var(--vk-ink-3)) 32%, transparent); background: color-mix(in srgb, var(--tone, var(--vk-ink-3)) 9%, transparent); color: var(--tone, var(--vk-ink-2)); font-size: 11px; font-weight: 500; white-space: nowrap; }
.vdg-badge.ok { --tone: var(--vk-ok); }
.vdg-badge.warn { --tone: var(--vk-warn); }
.vdg-badge.bad { --tone: var(--vk-bad); }
.vdg-badge.info { --tone: var(--vk-signal); }
.vdg-badge.outline { --tone: var(--vk-ink-3); background: transparent; }

.vdg-alert { padding: calc(var(--vk-u) * 2.5) calc(var(--vk-u) * 3); border: 1px solid var(--vk-line); border-left: 3px solid var(--tone, var(--vk-ink-3)); background: var(--vk-sunken); color: var(--vk-ink-2); font-size: 12px; overflow-wrap: anywhere; }
.vdg-alert.warn { --tone: var(--vk-warn); }
.vdg-alert.bad { --tone: var(--vk-bad); }

.vdg-sites { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--vk-u) * 2); }
.vdg-site { display: flex; flex-direction: column; gap: 2px; padding: calc(var(--vk-u) * 3); border: 1px solid var(--vk-line); background: var(--vk-panel); text-align: left; color: inherit; font: inherit; cursor: pointer; }
.vdg-site:hover:not(:disabled) { background: var(--vk-hover); border-color: var(--vk-line-strong); }
.vdg-site:disabled { cursor: default; opacity: .6; }
.vdg-site strong { font-weight: 600; }
.vdg-site span { color: var(--vk-ink-3); font-family: var(--vk-mono); font-size: 12px; }

.vdg-table-wrap { overflow-x: auto; }
.vdg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.vdg-table th { padding: calc(var(--vk-u) * 2); border-bottom: 1px solid var(--vk-line-strong); color: var(--vk-ink-3); font-weight: 500; text-align: left; white-space: nowrap; }
.vdg-table td { padding: calc(var(--vk-u) * 2); border-bottom: 1px solid var(--vk-line-soft); white-space: nowrap; }
.vdg-table tr:last-child td { border-bottom: 0; }
.vdg-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.vdg-table th:first-child, .vdg-table td:first-child { padding-left: calc(var(--vk-u) * 4); }
.vdg-table th:last-child, .vdg-table td:last-child { padding-right: calc(var(--vk-u) * 4); }
.vdg-table tr[aria-selected="true"] td { background: var(--vk-select); }
.vdg-table tr[aria-selected="true"] td:first-child { box-shadow: inset 2px 0 0 var(--vk-ember); }
.vdg-mono { font-family: var(--vk-mono); }

.vdg-progress { flex: 1; height: 4px; background: var(--vk-line-soft); }
.vdg-progress > div { height: 100%; background: var(--vk-ember); }

.vdg-overlay { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(12, 14, 17, .32); }
.vdg-dialog { display: flex; flex-direction: column; width: min(56rem, 100%); max-height: calc(100vh - 48px); border: 1px solid var(--vk-line-strong); background: var(--vk-panel); box-shadow: var(--vk-shadow-2); }
.vdg-dialog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 20px 0; }
.vdg-dialog-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.vdg-dialog-body { display: flex; flex-direction: column; gap: 12px; padding: 12px 20px 16px; overflow: auto; }
.vdg-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--vk-line); background: var(--vk-sunken); }
.vdg-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.vdg-facts dt { color: var(--vk-ink-3); font-size: 12px; }
.vdg-facts dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.vdg-details summary { cursor: pointer; color: var(--vk-ink-2); font-size: 12px; }

.vdg-popover { position: fixed; z-index: 1150; width: min(340px, calc(100vw - 24px)); border: 1px solid var(--vk-line-strong); background: var(--vk-panel); box-shadow: var(--vk-shadow-2); }
.vdg-popover::before { content: ""; position: absolute; left: -1px; top: -1px; width: calc(var(--vk-u) * 7); height: 2px; background: var(--vk-ember); }
.vdg-popover-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px 8px; }
.vdg-popover-head strong { font-size: 14px; }
.vdg-popover-body { display: flex; flex-direction: column; gap: 10px; padding: 0 14px 12px; }
.vdg-popover-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.vdg-popover-row > span { color: var(--vk-ink-2); font-size: 12px; }
.vdg-popover-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 14px; border-top: 1px solid var(--vk-line); background: var(--vk-sunken); }
.vdg-popover-foot .vdg-link { flex-shrink: 0; white-space: nowrap; }

.vdg-trigger { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, var(--vk-ink-2)); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.vdg-trigger:hover, .vdg-trigger[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover, var(--vk-hover)); }
.vdg-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone, var(--vk-ink-3)); }
.vdg-dot.ok { --tone: var(--vk-ok); }
.vdg-dot.warn { --tone: var(--vk-warn); }
.vdg-dot.off { --tone: var(--vk-line-strong); }

.vdg-prompt { display: flex; flex-direction: column; padding: 0 0 8px; }
.vdg-prompt-card { position: relative; display: flex; flex-direction: column; border: 1px solid var(--vk-line-strong); background: var(--vk-panel); }
.vdg-prompt-card::before { content: ""; position: absolute; left: -1px; top: -1px; width: calc(var(--vk-u) * 7); height: 2px; background: var(--vk-ember); }
.vdg-prompt-strip { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--vk-line-soft); color: var(--vk-ink-2); font-size: 12px; background: var(--vk-sunken); }
.vdg-prompt-body { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; max-height: 320px; overflow: auto; }
.vdg-prompt-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 14px 12px; }
.vdg-code { display: block; padding: 6px 8px; border: 1px solid var(--vk-line-soft); background: var(--vk-sunken); font-family: var(--vk-mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 160px; overflow: auto; }
`

/** Add the stylesheet once per page; returns a function that removes it again. */
export function installStyle(): () => void {
  const existing = document.querySelector<HTMLStyleElement>('style[data-plugin="vulcan-decision-guard"]')
  if (existing !== null) existing.remove()
  const tag = document.createElement('style')
  tag.dataset['plugin'] = 'vulcan-decision-guard'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
