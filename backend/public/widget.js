/**
 * Visa Assistant — Embeddable Widget (self-mounting, single-file)
 * ---------------------------------------------------------------
 * Drop this on any tenant page with ONE script tag:
 *   <script src="https://your-backend.example.com/widget.js" data-tenant="acme-retail" data-tenant-key="..."></script>
 *
 * data-tenant-key is optional — only needed if this tenant has a widget
 * key configured on the backend (see the admin panel's Tenants page for
 * the exact embed snippet to copy, including the key). It is NOT a secret
 * despite the name — it's sitting in this very page's HTML source, visible
 * to anyone who views it. Its purpose is per-tenant rate-limit/abuse
 * handling and the ability to revoke/rotate one tenant's key without
 * touching any other tenant, not confidentiality.
 */
(function () {
  "use strict";

  var THIS_SCRIPT = document.currentScript;
  var API_BASE = (THIS_SCRIPT && THIS_SCRIPT.dataset.apiBase) || (THIS_SCRIPT ? new URL(THIS_SCRIPT.src, window.location.href).origin : window.location.origin);
  var TENANT_ID = (THIS_SCRIPT && THIS_SCRIPT.dataset.tenant) || "default";
  // Sent as X-Widget-Key on every public request — NOT a true secret (it's
  // sitting right here in this page's HTML source), but lets the backend
  // apply per-tenant rate-limit/abuse handling and revoke/rotate one
  // tenant's key without affecting any other tenant. Optional: a tenant
  // with no widgetKey configured on the backend just isn't checked.
  var TENANT_KEY = (THIS_SCRIPT && THIS_SCRIPT.dataset.tenantKey) || "";
  var MAX_INPUT_LENGTH = 4000;

  // All persisted state is namespaced by TENANT_ID — critical so two tenant demo
  // pages on the same origin never leak each other's chat history (tenant isolation
  // applies to client-side storage too, not just the backend).
  var STORAGE_KEY_CHATS = "ib_chats_" + TENANT_ID;
  var STORAGE_KEY_ACTIVE = "ib_active_chat_" + TENANT_ID;

  function safeStorageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeStorageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable/full — degrade silently */ }
  }
  function safeStorageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function loadAllChats() {
    var raw = safeStorageGet(STORAGE_KEY_CHATS);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
  function saveAllChats(chats) {
    safeStorageSet(STORAGE_KEY_CHATS, JSON.stringify(chats));
  }
  function newChatId() {
    // crypto.randomUUID() (available in all modern browsers) rather than
    // Math.random() — sessionId keys automation/booking state server-side,
    // so a predictable ID is a real (if narrow) guessing-attack surface.
    // Falls back to the old Math.random()-based form only on genuinely
    // ancient browsers that lack crypto.randomUUID.
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return "chat_" + window.crypto.randomUUID();
    }
    return "chat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function chatTitleFrom(messages) {
    var firstUser = messages.filter(function (m) { return m.role === "user"; })[0];
    if (!firstUser) return "New chat";
    var t = firstUser.content.trim();
    return t.length > 42 ? t.slice(0, 42) + "…" : t;
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }
  function ensureDependencies() {
    var jobs = [];
    if (typeof window.marked === "undefined") jobs.push(loadScript("https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"));
    if (typeof window.Chart === "undefined") jobs.push(loadScript("https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.js"));
    if (typeof window.DOMPurify === "undefined") jobs.push(loadScript("https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"));
    return Promise.allSettled ? Promise.allSettled(jobs) : Promise.all(jobs.map(function (p) { return p.catch(function (e) { return e; }); }));
  }

// ---------------------------------------------------------------------------
// Styles — modern, minimalist, CSS-variable-driven for easy theming
// ---------------------------------------------------------------------------
var CSS = "\n" +
  "#ib-root { font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;" +
  " --ib-accent: #B8892E; --ib-accent-dark: #9F7525; --ib-accent-soft: #F4E8C8;" +
  " --ib-text: #0B1F3A; --ib-text-soft: #667085; --ib-border: #D9DEE5; --ib-bg: #F7F8FA; }\n" +
  "#ib-root *, #ib-root *::before, #ib-root *::after { box-sizing: border-box; }\n" +

  "@keyframes ib-fade-scale-in { from { opacity: 0; transform: translateY(14px) scale(.96); } to { opacity: 1; transform: translateY(0) scale(1); } }\n" +
  "@keyframes ib-msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }\n" +
  "@keyframes ib-pulse-ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ib-accent) 35%, transparent); } 70% { box-shadow: 0 0 0 12px color-mix(in srgb, var(--ib-accent) 0%, transparent); } 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ib-accent) 0%, transparent); } }\n" +
  "@keyframes ib-pop-in { from { opacity: 0; transform: scale(.7); } to { opacity: 1; transform: scale(1); } }\n" +

  ".ib-launcher { position: fixed; bottom: 24px; right: 24px; z-index: 999999; background: var(--ib-accent); color: #fff; border: none; border-radius: 50%; width: 60px; height: 60px; box-shadow: 0 8px 24px color-mix(in srgb, var(--ib-accent) 30%, transparent); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: transform .2s cubic-bezier(.34,1.56,.64,1); }\n" +
  ".ib-launcher.ib-attention { animation: ib-pulse-ring 2.2s infinite; }\n" +
  ".ib-launcher:hover { transform: scale(1.08) rotate(-3deg); }\n" +
  ".ib-launcher:active { transform: scale(.94); }\n" +
  ".ib-launcher svg { width: 26px; height: 26px; }\n" +

  ".ib-panel { position: fixed; bottom: 92px; right: 24px; z-index: 999999; width: min(420px, 94vw); height: min(680px, 80vh); background: #ffffff; border-radius: 24px; box-shadow: 0 24px 80px rgba(11,31,58,.12), 0 0 0 1px rgba(11,31,58,.06); display: flex; flex-direction: column; overflow: hidden; opacity: 0; visibility: hidden; pointer-events: none; transform: translateY(20px) scale(.96); transform-origin: bottom right; transition: opacity .25s ease, transform .25s cubic-bezier(.22,1,.36,1); }\n" +
  ".ib-panel.ib-open { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1); }\n" +
  ".ib-panel.ib-maximized { width: min(720px, 96vw); top: 20px; bottom: 20px; height: auto; }\n" +

  "@media (max-width: 480px) { .ib-panel { right: 8px; left: 8px; bottom: 84px; width: auto; height: min(600px, 78vh); border-radius: 20px; } .ib-launcher { bottom: 16px; right: 16px; } }\n" +

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------
  ".ib-header { background: #fff; border-bottom: 1px solid var(--ib-border); padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }\n" +
  ".ib-header-left { display: flex; align-items: center; gap: 8px; min-width: 0; }\n" +
  ".ib-logo { width: 24px; height: 24px; border-radius: 6px; object-fit: cover; flex-shrink: 0; }\n" +
  ".ib-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ib-accent); flex-shrink: 0; box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--ib-accent) 15%, transparent); }\n" +
  ".ib-title { font-weight: 700; font-size: 14px; color: var(--ib-text); letter-spacing: -.01em; }\n" +
  ".ib-subtitle { font-size: 11px; color: var(--ib-text-soft); margin-top: 1px; }\n" +
  ".ib-header-actions { display: flex; align-items: center; gap: 1px; }\n" +
  ".ib-icon-btn { background: none; border: none; color: var(--ib-text-soft); cursor: pointer; padding: 6px; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: all .15s ease; }\n" +
  ".ib-icon-btn:hover { color: var(--ib-text); background: #F7F8FA; }\n" +
  ".ib-icon-btn:active { transform: scale(.92); }\n" +
  ".ib-icon-btn svg { width: 16px; height: 16px; }\n" +

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  ".ib-messages { flex: 1; overflow-y: auto; padding: 20px 16px; background: var(--ib-bg); display: flex; flex-direction: column; gap: 8px; scroll-behavior: smooth; }\n" +
  ".ib-messages::-webkit-scrollbar { width: 5px; }\n" +
  ".ib-messages::-webkit-scrollbar-track { background: transparent; }\n" +
  ".ib-messages::-webkit-scrollbar-thumb { background: #D4B36A; border-radius: 10px; }\n" +
  ".ib-messages::-webkit-scrollbar-thumb:hover { background: var(--ib-accent); }\n" +

  ".ib-row { display: flex; flex-direction: column; animation: ib-msg-in .25s cubic-bezier(.22,1,.36,1); }\n" +
  ".ib-row.ib-row-user { align-items: flex-end; }\n" +
  ".ib-row.ib-row-bot { position: relative; }\n" +
  ".ib-bubble-wrap { display: flex; flex-direction: column; max-width: 88%; }\n" +
  ".ib-row-user .ib-bubble-wrap { align-items: flex-end; }\n" +
  ".ib-bubble { border-radius: 20px; padding: 12px 16px; font-size: 13px; line-height: 1.6; position: relative; }\n" +

  // User message
  ".ib-bubble-user { background: var(--ib-accent); color: #fff; border-bottom-right-radius: 6px; box-shadow: 0 4px 12px color-mix(in srgb, var(--ib-accent) 18%, transparent); }\n" +

  // Bot message
  ".ib-bubble-bot { background: #fff; color: #172033; border-bottom-left-radius: 6px; box-shadow: 0 1px 3px rgba(11,31,58,.04); border: 1px solid var(--ib-border); }\n" +

  ".ib-msg-content { overflow-x: auto; }\n" +

  // -------------------------------------------------------------------------
  // Markdown output
  // -------------------------------------------------------------------------
  ".ib-msg-content p { margin: 0 0 10px; line-height: 1.5; }\n" +
  ".ib-msg-content p:last-child { margin-bottom: 0; }\n" +

  ".ib-msg-content ul, .ib-msg-content ol { margin: 0 0 10px; padding-left: 22px; list-style-position: outside; }\n" +
  ".ib-msg-content ul { list-style-type: disc; }\n" +
  ".ib-msg-content ol { list-style-type: decimal; }\n" +
  ".ib-msg-content li { margin: 0 0 4px; line-height: 1.5; }\n" +
  ".ib-msg-content li:last-child { margin-bottom: 0; }\n" +
  ".ib-msg-content li > ul, .ib-msg-content li > ol { margin-top: 4px; }\n" +

  ".ib-msg-content h1, .ib-msg-content h2, .ib-msg-content h3, .ib-msg-content h4 { margin: 14px 0 6px; line-height: 1.3; font-weight: 600; color: var(--ib-text); }\n" +
  ".ib-msg-content h1:first-child, .ib-msg-content h2:first-child, .ib-msg-content h3:first-child, .ib-msg-content h4:first-child { margin-top: 0; }\n" +
  ".ib-msg-content h1 { font-size: 18px; }\n" +
  ".ib-msg-content h2 { font-size: 16px; }\n" +
  ".ib-msg-content h3, .ib-msg-content h4 { font-size: 14px; }\n" +

  ".ib-msg-content strong, .ib-msg-content b { font-weight: 600; }\n" +
  ".ib-msg-content em, .ib-msg-content i { font-style: italic; }\n" +

  ".ib-msg-content blockquote { margin: 0 0 10px; padding: 4px 12px; border-left: 3px solid var(--ib-accent); color: var(--ib-text-soft); }\n" +

  ".ib-msg-content code { font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 12.5px; background: #F7F8FA; border: 1px solid var(--ib-border); border-radius: 4px; padding: 1px 5px; }\n" +

  ".ib-msg-content pre { margin: 0 0 10px; padding: 10px 12px; background: #F7F8FA; border: 1px solid var(--ib-border); border-radius: 8px; overflow-x: auto; }\n" +
  ".ib-msg-content pre code { background: none; border: none; padding: 0; }\n" +

  ".ib-msg-content hr { border: none; border-top: 1px solid var(--ib-border); margin: 12px 0; }\n" +

  ".ib-msg-content a:not(.ib-link-btn) { color: var(--ib-accent); text-decoration: underline; }\n" +
  ".ib-msg-content a:not(.ib-link-btn):hover { color: var(--ib-accent-dark); }\n" +

  // Link buttons
  ".ib-msg-content .ib-link-btn { display: inline-flex; align-items: center; gap: 6px; background: #fff; color: var(--ib-text); border: 1px solid var(--ib-border); border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 500; text-decoration: none; transition: all .15s ease; box-shadow: 0 1px 2px rgba(0,0,0,.04); }\n" +
  ".ib-msg-content .ib-link-btn:hover { background: #FFFDF8; border-color: var(--ib-accent); transform: translateY(-1px); box-shadow: 0 2px 8px color-mix(in srgb, var(--ib-accent) 10%, transparent); }\n" +

  // Tables
  ".ib-msg-content table { width: max-content; min-width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }\n" +
  ".ib-msg-content th, .ib-msg-content td { border: 1px solid var(--ib-border); padding: 8px 12px; text-align: left; color: #172033; }\n" +
  ".ib-msg-content th { background: #F7F8FA; font-weight: 600; color: var(--ib-text); }\n" +
  ".ib-msg-content tr:nth-child(even) td { background: #FAFBFC; }\n" +

  // -------------------------------------------------------------------------
  // Message actions
  // -------------------------------------------------------------------------
  ".ib-msg-actions { position: absolute; bottom: 6px; right: 6px; display: flex; gap: 2px; opacity: 0; transition: opacity .15s ease; z-index: 2; }\n" +
  ".ib-row-bot:hover .ib-msg-actions, .ib-msg-actions.ib-force-show { opacity: 1; }\n" +

  ".ib-msg-copy-btn { background: #fff; border: 1px solid var(--ib-border); color: #667085; cursor: pointer; padding: 4px; border-radius: 6px; font-size: 11px; transition: all .15s ease; display: inline-flex; align-items: center; gap: 4px; }\n" +
  ".ib-msg-copy-btn:hover { color: var(--ib-accent); border-color: var(--ib-accent); background: #FFFDF8; }\n" +

  // -------------------------------------------------------------------------
  // Scroll button
  // -------------------------------------------------------------------------
  ".ib-scroll-down-btn { position: absolute; bottom: 40px; right: 20px; transform: scale(1); background: #fff; border: 1px solid var(--ib-border); box-shadow: 0 4px 12px rgba(11,31,58,.08); color: var(--ib-accent); border-radius: 50%; width: 34px; height: 34px; display: none; align-items: center; justify-content: center; cursor: pointer; z-index: 10; transition: all .15s ease; }\n" +
  ".ib-scroll-down-btn.ib-show { display: flex; animation: ib-pop-in .2s cubic-bezier(.34,1.56,.64,1); }\n" +
  ".ib-scroll-down-btn:hover { transform: scale(1.1); box-shadow: 0 6px 16px rgba(11,31,58,.12); }\n" +
  ".ib-scroll-down-btn svg { width: 16px; height: 16px; }\n" +

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  ".ib-inputbar { border-top: 1px solid var(--ib-border); background: #fff; padding: 10px; flex-shrink: 0; }\n" +
  ".ib-inputrow { display: flex; align-items: flex-end; gap: 8px; }\n" +

  ".ib-textarea { flex: 1; resize: none; border: 1.5px solid var(--ib-border); border-radius: 18px; padding: 8px 12px; font-size: 13px; font-family: inherit; max-height: 100px; outline: none; transition: all .15s ease; background: #FFFFFF; color: var(--ib-text); line-height: 1.5; }\n" +
  ".ib-textarea:focus { border-color: var(--ib-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ib-accent) 12%, transparent); background: #fff; }\n" +
  ".ib-textarea::placeholder { color: #7A8492; }\n" +

  // Send button
  ".ib-send-btn { background: var(--ib-accent); color: #fff; border: none; border-radius: 50%; width: 38px; height: 38px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all .2s cubic-bezier(.34,1.56,.64,1); box-shadow: 0 4px 14px color-mix(in srgb, var(--ib-accent) 25%, transparent); }\n" +
  ".ib-send-btn:hover { transform: scale(1.08); box-shadow: 0 6px 20px color-mix(in srgb, var(--ib-accent) 35%, transparent); }\n" +
  ".ib-send-btn:active { transform: scale(.92); }\n" +
  ".ib-send-btn.ib-stop-mode { background: #DC2626; box-shadow: 0 4px 14px rgba(220,38,38,.25); }\n" +
  ".ib-send-btn:disabled { background: #D9DEE5; color: #98A2B3; box-shadow: none; transform: none; cursor: not-allowed; }\n" +

  ".ib-footnote { font-size: 10px; color: #7A8492; text-align: center; margin-top: 4px; }\n" +

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------
  ".ib-history-page { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #F7F8FA; z-index: 15; display: none; flex-direction: column; animation: ib-msg-in .2s cubic-bezier(.22,1,.36,1); }\n" +
  ".ib-history-page.ib-show { display: flex; }\n" +

  ".ib-history-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; background: #fff; border-bottom: 1px solid var(--ib-border); flex-shrink: 0; }\n" +

  ".ib-history-back-btn { background: none; border: none; color: var(--ib-text-soft); cursor: pointer; padding: 8px; border-radius: 10px; display: flex; align-items: center; gap: 6px; transition: all .15s ease; flex-shrink: 0; }\n" +
  ".ib-history-back-btn:hover { color: var(--ib-text); background: #FFFDF8; }\n" +
  ".ib-history-back-btn:active { transform: scale(.92); }\n" +
  ".ib-history-back-btn svg { width: 18px; height: 18px; }\n" +

  ".ib-history-title { font-weight: 700; font-size: 16px; color: var(--ib-text); letter-spacing: -.01em; }\n" +

  ".ib-history-list { flex: 1; overflow-y: auto; padding: 8px 12px 70px; }\n" +
  ".ib-history-section { margin-bottom: 14px; }\n" +
  ".ib-history-section-header { font-size: 12px; font-weight: 600; color: var(--ib-text-soft); text-transform: uppercase; letter-spacing: .02em; margin-bottom: 8px; padding: 0 4px; }\n" +

  ".ib-history-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #fff; border: 1px solid var(--ib-border); border-radius: 12px; cursor: pointer; transition: all .15s ease; margin-bottom: 6px; }\n" +
  ".ib-history-item:hover { background: #FAFBFC; border-color: var(--ib-accent); box-shadow: 0 2px 6px rgba(11,31,58,.04); }\n" +
  ".ib-history-item.ib-active { background: #FFFDF8; border-color: var(--ib-accent); }\n" +

  ".ib-history-item-icon { width: 30px; height: 30px; border-radius: 50%; background: var(--ib-accent-soft); display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--ib-accent); }\n" +
  ".ib-history-item-icon svg { width: 16px; height: 16px; }\n" +

  ".ib-history-item-info { flex: 1; min-width: 0; }\n" +
  ".ib-history-item-title { font-size: 12px; font-weight: 500; color: var(--ib-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n" +
  ".ib-history-item-meta { font-size: 10px; color: var(--ib-text-soft); margin-top: 1px; }\n" +

  ".ib-history-item-menu { background: none; border: none; color: #667085; cursor: pointer; padding: 4px; border-radius: 6px; display: flex; align-items: center; transition: all .15s ease; flex-shrink: 0; }\n" +
  ".ib-history-item-menu:hover { color: #DC2626; background: #FEF2F2; }\n" +
  ".ib-history-item-menu svg { width: 16px; height: 16px; }\n" +

  ".ib-history-empty { padding: 30px 16px; text-align: center; color: var(--ib-text-soft); }\n" +
  ".ib-history-empty-icon { width: 40px; height: 40px; margin: 0 auto 10px; background: var(--ib-accent-soft); border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--ib-accent); }\n" +
  ".ib-history-empty-icon svg { width: 20px; height: 20px; }\n" +
  ".ib-history-empty-title { font-size: 14px; font-weight: 600; color: var(--ib-text); margin-bottom: 3px; }\n" +
  ".ib-history-empty-text { font-size: 12px; color: var(--ib-text-soft); }\n" +

  ".ib-history-new-chat-bar { position: absolute; bottom: 0; left: 0; right: 0; padding: 12px; background: linear-gradient(to top, #F7F8FA 80%, transparent); flex-shrink: 0; }\n" +

  ".ib-history-new-chat-btn { width: 100%; padding: 12px; background: var(--ib-accent); color: #fff; border: none; border-radius: 12px; cursor: pointer; font-size: 13px; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 8px; transition: all .15s ease; box-shadow: 0 4px 12px color-mix(in srgb, var(--ib-accent) 25%, transparent); }\n" +
  ".ib-history-new-chat-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px color-mix(in srgb, var(--ib-accent) 30%, transparent); }\n" +
  ".ib-history-new-chat-btn:active { transform: translateY(0) scale(.98); }\n" +
  ".ib-history-new-chat-btn svg { width: 16px; height: 16px; }\n" +

  // -------------------------------------------------------------------------
  // Chips
  // -------------------------------------------------------------------------
  ".ib-chips-label { font-size: 12px; font-weight: 600; color: var(--ib-text-soft); margin: 4px 0 8px 2px; }\n" +
  ".ib-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }\n" +

  ".ib-chip { font-size: 12px; font-weight: 500; background: #fff; color: var(--ib-text); border: 1px solid var(--ib-border); border-radius: 999px; padding: 8px 14px; cursor: pointer; transition: all .15s ease; }\n" +
  ".ib-chip:hover { background: #FFFDF8; border-color: var(--ib-accent); color: var(--ib-text); transform: translateY(-1px); box-shadow: 0 2px 8px color-mix(in srgb, var(--ib-accent) 10%, transparent); }\n" +
  ".ib-chip:active { transform: translateY(0) scale(.97); }\n" +

  "@keyframes ib-chip-wave { 0% { background-position: -150% 0; } 100% { background-position: 250% 0; } }\n" +

  // -------------------------------------------------------------------------
  // Welcome
  // -------------------------------------------------------------------------
  ".ib-welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; padding: 28px 20px; text-align: center; }\n" +
  ".ib-welcome-avatar { width: 56px; height: 56px; border-radius: 50%; background: var(--ib-accent-soft); color: var(--ib-accent-dark); display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 600; overflow: hidden; flex-shrink: 0; }\n" +
  ".ib-welcome-avatar img { width: 100%; height: 100%; object-fit: cover; }\n" +
  ".ib-welcome-title { font-size: 16px; font-weight: 600; color: var(--ib-text); margin: 0 0 4px; }\n" +
  ".ib-welcome-sub { font-size: 13px; color: var(--ib-text-soft); margin: 0; line-height: 1.6; max-width: 280px; }\n" +

  ".ib-wave-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 320px; }\n" +
  ".ib-wave-chip { position: relative; overflow: hidden; background: #fff; border: 1px solid var(--ib-border); color: var(--ib-text); border-radius: 999px; padding: 10px 16px; font-size: 12.5px; font-weight: 500; cursor: pointer; transition: border-color .15s ease, transform .15s ease; }\n" +
  ".ib-wave-chip:hover { border-color: var(--ib-accent); transform: translateY(-1px); }\n" +
  ".ib-wave-chip:active { transform: translateY(0) scale(.97); }\n" +
  ".ib-wave-chip::after { content: \"\"; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 35%, color-mix(in srgb, var(--ib-accent) 6%, transparent) 50%, transparent 65%); background-size: 200% 100%; animation: ib-chip-wave 3.2s ease-in-out infinite; animation-delay: var(--ib-wave-delay, 0s); pointer-events: none; }\n" +

  // -------------------------------------------------------------------------
  // Typing / Status
  // -------------------------------------------------------------------------
  ".ib-typing-row { display: flex; align-items: center; gap: 8px; color: var(--ib-text); font-size: 13px; font-weight: 500; }\n" +
  ".ib-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ib-accent); animation: ib-bounce 1.4s infinite ease-in-out; }\n" +
  ".ib-dot:nth-child(2) { animation-delay: .15s; }\n" +
  ".ib-dot:nth-child(3) { animation-delay: .3s; }\n" +

  "@keyframes ib-bounce { 0%,80%,100% { transform: scale(.5); opacity: .3; } 40% { transform: scale(1); opacity: 1; } }\n" +

  ".ib-status-track { position: relative; height: 4px; width: 100%; background: #E2E8F0; border-radius: 999px; overflow: hidden; margin-top: 10px; }\n" +
  ".ib-status-fill { position: absolute; top: 0; left: -30%; height: 100%; width: 30%; border-radius: 999px; background: linear-gradient(90deg, var(--ib-accent), var(--ib-accent-dark)); animation: ib-slide 1.4s ease-in-out infinite; }\n" +
  "@keyframes ib-slide { 0% { left: -30%; } 100% { left: 100%; } }\n" +

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------
  ".ib-form-wrap { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--ib-border); border-radius: 10px; background: #FAFBFC; margin-top: 6px; }\n" +
  ".ib-form-title { font-size: 13px; font-weight: 600; color: var(--ib-text); margin-bottom: 2px; }\n" +
  ".ib-form-row { display: flex; flex-direction: column; gap: 4px; }\n" +
  ".ib-form-label { font-size: 12px; font-weight: 500; color: var(--ib-text-soft); }\n" +
  ".ib-form-input { font-size: 13px; padding: 8px 10px; border: 1px solid var(--ib-border); border-radius: 8px; background: #fff; color: var(--ib-text); font-family: inherit; }\n" +
  ".ib-form-input:focus { outline: none; border-color: var(--ib-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ib-accent) 12%, transparent); }\n" +
  ".ib-form-input-invalid { border-color: #C0392B; }\n" +
  ".ib-form-error { font-size: 11.5px; color: #C0392B; }\n" +
  ".ib-form-submit-row { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }\n" +
  ".ib-form-submit-btn { align-self: flex-start; font-size: 13px; font-weight: 600; color: #fff; background: var(--ib-accent); border: none; border-radius: 8px; padding: 8px 16px; cursor: pointer; transition: background .15s ease; }\n" +
  ".ib-form-submit-btn:hover:not(:disabled) { background: var(--ib-accent-dark); }\n" +
  ".ib-form-submit-btn:disabled { opacity: .7; cursor: default; }\n";

function injectStyles() {
  var style = document.createElement("style");
  style.setAttribute("data-visa-assistant", "true");
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8-1.06 0-2.077-.163-3.02-.465L3 21l1.395-4.184C3.512 15.767 3 14.42 3 13c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>';

var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';

var ICON_SEND = '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M2.94 2.94a1.5 1.5 0 011.66-.32l13 5.5a1.5 1.5 0 010 2.76l-13 5.5a1.5 1.5 0 01-2.08-1.83L3.9 10 2.52 4.77a1.5 1.5 0 01.42-1.83z"/></svg>';

var ICON_STOP = '<svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><rect x="4" y="4" width="12" height="12" rx="2"/></svg>';

var ICON_MINIMIZE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" d="M5 12h14"/></svg>';

var ICON_MAXIMIZE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';

var ICON_RESTORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3v4a1 1 0 01-1 1H4m16-5v4a1 1 0 01-1 1h-4M4 15h4a1 1 0 011 1v4m10-5h-4a1 1 0 00-1 1v4"/></svg>';

var ICON_HISTORY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-9-9 9 9 0 019 9z"/></svg>';

var ICON_NEWCHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>';

var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14M4 6h16M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';

var ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';

var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';

var ICON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>';
  
  function buildMarkup() {
    var root = document.createElement("div");
    root.id = "ib-root";
    root.innerHTML =
      '<button class="ib-launcher ib-attention" id="ib-launcher" aria-label="Open chat">' + ICON_CHAT + "</button>" +
      '<div class="ib-panel" id="ib-panel">' +
        '<div class="ib-header">' +
          '<div class="ib-header-left">' +
            '<img class="ib-logo" id="ib-logo" alt="" style="display:none" />' +
            '<span class="ib-status-dot" id="ib-status-dot"></span>' +
            '<div style="min-width:0"><div class="ib-title" id="ib-title">Visa Assistant</div><div class="ib-subtitle" id="ib-subtitle">Admissions & Visa Help</div></div>' +
          "</div>" +
          '<div class="ib-header-actions">' +
            '<button class="ib-icon-btn" id="ib-newchat-btn" aria-label="New chat" title="New chat">' + ICON_NEWCHAT + "</button>" +
            '<button class="ib-icon-btn" id="ib-history-btn" aria-label="Chat history" title="Chat history">' + ICON_HISTORY + "</button>" +
            '<button class="ib-icon-btn" id="ib-maximize-btn" aria-label="Maximize" title="Maximize">' + ICON_MAXIMIZE + "</button>" +
            '<button class="ib-icon-btn" id="ib-close-btn" aria-label="Close chat" title="Close">' + ICON_CLOSE + "</button>" +
          "</div>" +
        "</div>" +
        '<div class="ib-history-page" id="ib-history-page">' +
          '<div class="ib-history-header">' +
            '<button class="ib-history-back-btn" id="ib-history-back-btn" aria-label="Back">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>' +
              ' Back' +
            '</button>' +
            '<span class="ib-history-title">Recent History</span>' +
            '<span style="width:70px"></span>' +
          '</div>' +
          '<div class="ib-history-list" id="ib-history-list"></div>' +
          '<div class="ib-history-new-chat-bar">' +
            '<button class="ib-history-new-chat-btn" id="ib-history-new-chat-btn">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>' +
              ' Start new chat' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="ib-messages" id="ib-messages"></div>' +
        '<button class="ib-scroll-down-btn" id="ib-scroll-down-btn" aria-label="Scroll to latest">' + ICON_DOWN + "</button>" +
        '<div class="ib-inputbar">' +
          '<div class="ib-inputrow">' +
            '<textarea class="ib-textarea" id="ib-input" rows="1" maxlength="' + MAX_INPUT_LENGTH + '" placeholder="Ask about visas, study or our services..."></textarea>' +
            '<button class="ib-send-btn" id="ib-send-btn" type="button" aria-label="Send">' + ICON_SEND + "</button>" +
          "</div>" +
          '<div class="ib-footnote">Answers are grounded strictly in this consultancy\'s data.</div>' +
        "</div>" +
      "</div>";
    document.body.appendChild(root);
  }

  // ---------------------------------------------------------------------------
  // Main widget logic
  // ---------------------------------------------------------------------------
  function initWidget() {
    var els = {
      launcher: document.getElementById("ib-launcher"),
      panel: document.getElementById("ib-panel"),
      closeBtn: document.getElementById("ib-close-btn"),
      maximizeBtn: document.getElementById("ib-maximize-btn"),
      newChatBtn: document.getElementById("ib-newchat-btn"),
      historyBtn: document.getElementById("ib-history-btn"),
      historyPage: document.getElementById("ib-history-page"),
      historyList: document.getElementById("ib-history-list"),
      historyBackBtn: document.getElementById("ib-history-back-btn"),
      historyNewChatBtn: document.getElementById("ib-history-new-chat-btn"),
      messages: document.getElementById("ib-messages"),
      scrollDownBtn: document.getElementById("ib-scroll-down-btn"),
      input: document.getElementById("ib-input"),
      sendBtn: document.getElementById("ib-send-btn"),
      title: document.getElementById("ib-title"),
      subtitle: document.getElementById("ib-subtitle"),
    };

    var conversation = [];
    var isStreaming = false;
    var panelOpenedOnce = false;
    var currentAbortController = null;
    var activeChatId = null;
    var userScrolledUp = false;
    var tenantConfig = { title: "Visa Assistant", subtitle: "Admissions & Visa Help", suggestedQuestions: [] };

    var missingLibs = [];
    if (typeof window.marked === "undefined") missingLibs.push("marked.js (Markdown rendering)");
    if (typeof window.Chart === "undefined") missingLibs.push("Chart.js (charts)");
    if (typeof window.DOMPurify === "undefined") missingLibs.push("DOMPurify (output sanitization)");

    var renderer = null;
    if (typeof window.marked !== "undefined") {
      renderer = new window.marked.Renderer();
      renderer.link = function (href, title, text) {
        var hrefStr = typeof href === "object" && href !== null ? href.href : href;
        var textStr = typeof href === "object" && href !== null ? (href.text || href.title || "") : (text || "");
        var rawHref = String(hrefStr || "");
        // Only allow http(s) links through — blocks javascript:, data:, vbscript:, etc.
        var isSafeScheme = /^https?:\/\//i.test(rawHref) || /^\//.test(rawHref);
        var safeHref = (isSafeScheme ? rawHref : "#").replace(/"/g, "&quot;");
        var label = escapeHtml(textStr || safeHref);
        return '<a class="ib-link-btn" href="' + safeHref + '" target="_blank" rel="noopener noreferrer">' + label + " ↗</a>";
      };
      window.marked.setOptions({ gfm: true, breaks: true, renderer: renderer });
    }

    // -------------------------------------------------------------------
    // Tenant config
    // -------------------------------------------------------------------
    // Re-themes everything already built on var(--ib-*) — borders, message
    // backgrounds, soft text, etc. A number of elements (notably the
    // launcher button and some shadow/glow colors) are still hardcoded hex
    // rather than variable-driven, so this covers most but not all of the
    // widget's color surface. Widening that is a further pass, not done
    // here — flagging honestly rather than silently leaving gaps.
    function applyTheme(theme) {
      if (!theme || typeof theme !== "object") return;

      // Logo — independent of the color overrides below, so a tenant can
      // set just a logo without needing to also override every color.
      var logoEl = document.getElementById("ib-logo");
      if (logoEl) {
        var imageUrl = typeof theme.imageUrl === "string" ? theme.imageUrl.trim() : "";
        var isSafeImageUrl = /^https:\/\//i.test(imageUrl); // https-only: this loads on every tenant's site, no mixed-content/plain-http exceptions
        if (isSafeImageUrl) {
          logoEl.src = imageUrl;
          logoEl.style.display = "";
          logoEl.onerror = function () { logoEl.style.display = "none"; }; // bad/dead URL — fail quiet, don't show a broken-image icon
        } else {
          logoEl.style.display = "none";
        }
      }

      var allowed = ["accent", "accentDark", "accentSoft", "text", "textSoft", "border", "bg"];
      var cssVarNames = { accent: "--ib-accent", accentDark: "--ib-accent-dark", accentSoft: "--ib-accent-soft", text: "--ib-text", textSoft: "--ib-text-soft", border: "--ib-border", bg: "--ib-bg" };
      var hexPattern = /^#[0-9a-fA-F]{3,8}$/;
      var declarations = [];
      allowed.forEach(function (key) {
        var value = theme[key];
        if (typeof value === "string" && hexPattern.test(value.trim())) {
          declarations.push(cssVarNames[key] + ": " + value.trim());
        }
      });
      if (!declarations.length) return;

      var existing = document.getElementById("ib-theme-override");
      var styleEl = existing || document.createElement("style");
      styleEl.id = "ib-theme-override";
      // Higher specificity than the base "#ib-root { ... }" rule below it
      // in the document, so these win without needing !important.
      styleEl.textContent = "#ib-root#ib-root { " + declarations.join("; ") + "; }";
      if (!existing) document.head.appendChild(styleEl);
    }

    // Full custom CSS/JS — set by the tenant's own admin in the admin
    // panel (Branding / Custom code pane), scoped to this tenant only via
    // the same tenantId + X-Widget-Key check tenant-config already does.
    //
    // This is intentionally NOT sandboxed. A tenant admin who can set
    // customJs can already put a <script> tag directly on their own site —
    // this doesn't grant new capability, it's just a more convenient place
    // to put it. The only things worth being careful about here are (a)
    // never HTML-parsing this content (both go in via .textContent, a text
    // node, not innerHTML — a stray "</script>" or "</style>" in the
    // string can't break out of anything because there's no markup being
    // parsed), and (b) making sure custom JS errors can't break the rest
    // of the widget for every visitor if the tenant ships a typo.
    function applyCustomCss(css) {
      if (typeof css !== "string" || !css) return;
      try {
        var existing = document.getElementById("ib-custom-css");
        var styleEl = existing || document.createElement("style");
        styleEl.id = "ib-custom-css";
        styleEl.textContent = css; // text node — never parsed as HTML, so no </style>-breakout risk
        if (!existing) document.head.appendChild(styleEl);
      } catch (err) {
        console.error("[chatbot widget] applyCustomCss failed:", err);
      }
    }

    function runCustomJs(js) {
      if (typeof js !== "string" || !js) return;
      try {
        // Function(), not eval() — runs in its own scope (no access to
        // this closure's local vars), still has the page's global/window
        // scope, which is what a tenant customization actually needs
        // (same as any inline <script> they'd otherwise add themselves).
        new Function(js)();
      } catch (err) {
        // One tenant's broken custom JS must never take the chat widget
        // down for their visitors — log and keep going.
        console.error("[chatbot widget] tenant customJs threw:", err);
      }
    }

    function loadTenantConfig() {
      return fetch(API_BASE + "/api/tenant-config?tenantId=" + encodeURIComponent(TENANT_ID), { headers: TENANT_KEY ? { "X-Widget-Key": TENANT_KEY } : {} })
        .then(function (r) { if (!r.ok) throw new Error("tenant-config request failed"); return r.json(); })
        .then(function (data) {
          tenantConfig.title = data.title || tenantConfig.title;
          tenantConfig.subtitle = data.subtitle || tenantConfig.subtitle;
          tenantConfig.suggestedQuestions = Array.isArray(data.suggestedQuestions) ? data.suggestedQuestions : [];
          els.title.textContent = tenantConfig.title;
          els.subtitle.textContent = tenantConfig.subtitle;
          applyTheme(data.theme);
          applyCustomCss(data.customCss);
          // Last, and only after everything above — so custom JS can
          // safely assume the widget's DOM/theme/CSS is already in place.
          runCustomJs(data.customJs);
        })
        .catch(function () {
          // No fake tenant-specific-looking content on failure — the widget
          // still works without starter chips, that's better than showing
          // generic questions that may have nothing to do with this tenant.
          tenantConfig.suggestedQuestions = [];
        });
    }

    // -------------------------------------------------------------------
    // Open / close / minimize / maximize
    // -------------------------------------------------------------------
    function openPanel() {
      els.panel.classList.add("ib-open");
      els.panel.classList.remove("ib-maximized");
      els.launcher.classList.remove("ib-attention");
      els.launcher.innerHTML = ICON_CLOSE;
      els.maximizeBtn.innerHTML = ICON_MAXIMIZE;
      els.maximizeBtn.title = "Maximize";
      els.input.focus();
      if (!panelOpenedOnce) {
        panelOpenedOnce = true;
        restoreOrStartChat();
      }
    }
    function closePanel() {
      els.panel.classList.remove("ib-open");
      els.launcher.classList.add("ib-attention");
      els.launcher.innerHTML = ICON_NEWCHAT;
      closeHistoryPage();
    }
    els.launcher.addEventListener("click", function () {
      els.panel.classList.contains("ib-open") ? closePanel() : openPanel();
    });
    els.closeBtn.addEventListener("click", closePanel);

    els.maximizeBtn.addEventListener("click", function () {
      var nowMax = els.panel.classList.toggle("ib-maximized");
      els.maximizeBtn.innerHTML = nowMax ? ICON_MINIMIZE : ICON_MAXIMIZE;
      els.maximizeBtn.title = nowMax ? "Minimize" : "Maximize";
    });

    // -------------------------------------------------------------------
    // Textarea + send/stop button
    // -------------------------------------------------------------------
    els.input.addEventListener("input", function () {
      els.input.style.height = "auto";
      els.input.style.height = Math.min(els.input.scrollHeight, 96) + "px";
    });
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitCurrentInput();
      }
    });
    els.sendBtn.addEventListener("click", function () {
      if (isStreaming) {
        if (currentAbortController) currentAbortController.abort();
      } else {
        submitCurrentInput();
      }
    });
    function submitCurrentInput() {
      var text = els.input.value.trim().slice(0, MAX_INPUT_LENGTH);
      if (!text || isStreaming) return;
      els.input.value = "";
      els.input.style.height = "auto";
      sendMessage(text);
    }
    function setStreamingUI(streaming) {
      isStreaming = streaming;
      els.sendBtn.classList.toggle("ib-stop-mode", streaming);
      els.sendBtn.innerHTML = streaming ? ICON_STOP : ICON_SEND;
      els.sendBtn.setAttribute("aria-label", streaming ? "Stop" : "Send");
      els.sendBtn.disabled = false; // stays clickable in both states (click = send OR stop)
    }

    // -------------------------------------------------------------------
    // Scroll handling: never force-scroll while the user has scrolled up to
    // read earlier content. Show a floating down-arrow instead.
    // -------------------------------------------------------------------
    function isNearBottom() {
      var m = els.messages;
      return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    }
    function scrollToBottomForce() {
      els.messages.scrollTop = els.messages.scrollHeight;
      userScrolledUp = false;
      els.scrollDownBtn.classList.remove("ib-show");
    }
    function scrollALittle() {
      var m = els.messages;
      var target = Math.min(m.scrollHeight, m.scrollTop + 120);
      m.scrollTo({ top: target, behavior: "smooth" });
      userScrolledUp = true;
      els.scrollDownBtn.classList.add("ib-show");
    }
    function maybeAutoScroll() {
      if (!userScrolledUp) {
        scrollToBottomForce();
      } else {
        els.scrollDownBtn.classList.add("ib-show");
      }
    }
    els.messages.addEventListener("scroll", function () {
      userScrolledUp = !isNearBottom();
      if (!userScrolledUp) els.scrollDownBtn.classList.remove("ib-show");
    });
    els.scrollDownBtn.addEventListener("click", scrollToBottomForce);

    // -------------------------------------------------------------------
    // Bubble helpers
    // -------------------------------------------------------------------
    function createRow(role) {
      var row = document.createElement("div");
      row.className = "ib-row" + (role === "user" ? " ib-row-user" : " ib-row-bot");
      var wrap = document.createElement("div");
      wrap.className = "ib-bubble-wrap";
      var bubble = document.createElement("div");
      bubble.className = "ib-bubble " + (role === "user" ? "ib-bubble-user" : "ib-bubble-bot");
      wrap.appendChild(bubble);
      row.appendChild(wrap);
      els.messages.appendChild(row);
      maybeAutoScroll();
      return bubble;
    }
    function renderUserMessage(text) {
      var b = createRow("user");
      b.textContent = text;
    }
    function escapeHtml(str) {
      var d = document.createElement("div");
      d.textContent = str;
      return d.innerHTML;
    }
    function convertLinksToButtons(container) {
      var links = container.querySelectorAll("a:not(.ib-link-btn)");
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var btn = document.createElement("a");
        btn.className = "ib-link-btn";
        btn.href = a.href;
        btn.target = "_blank";
        btn.rel = "noopener noreferrer";
        btn.innerHTML = a.innerHTML || a.textContent;
        a.parentNode.replaceChild(btn, a);
      }
    }

    // Copy-message button, added under a completed assistant bubble
    function addCopyButton(wrapEl, getText) {
      var actions = document.createElement("div");
      actions.className = "ib-msg-actions";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ib-msg-copy-btn";
      btn.innerHTML = ICON_COPY;
      btn.addEventListener("click", function () {
        var text = getText();
        var done = function () {
          btn.innerHTML = ICON_CHECK;
          actions.classList.add("ib-force-show");
          setTimeout(function () {
            btn.innerHTML = ICON_COPY;
            actions.classList.remove("ib-force-show");
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
        } else {
          fallbackCopy(text);
          done();
        }
      });
      actions.appendChild(btn);
      wrapEl.appendChild(actions);
    }
    function fallbackCopy(text) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) { /* best effort */ }
      document.body.removeChild(ta);
    }

    function renderSuggestedQuestionsOnly(questions) {
      var row = document.createElement("div");
      row.className = "ib-welcome";
      row.id = "ib-welcome";

      var avatar = document.createElement("div");
      avatar.className = "ib-welcome-avatar";
      var logoImgEl = document.getElementById("ib-logo");
      var logoUrl = logoImgEl && logoImgEl.style.display !== "none" ? logoImgEl.src : "";
      if (logoUrl) {
        var img = document.createElement("img");
        img.src = logoUrl;
        img.alt = "";
        avatar.appendChild(img);
      } else {
        avatar.textContent = getInitials(tenantConfig.title);
      }
      row.appendChild(avatar);

      var titleEl = document.createElement("div");
      titleEl.className = "ib-welcome-title";
      titleEl.textContent = "Hi, I'm here to help";
      row.appendChild(titleEl);

      var subEl = document.createElement("div");
      subEl.className = "ib-welcome-sub";
      subEl.textContent = tenantConfig.subtitle || "Ask me anything and I'll do my best to help.";
      row.appendChild(subEl);

      var chipWrap = document.createElement("div");
      chipWrap.className = "ib-wave-chips";
      var list = questions && questions.length ? questions : ["What are the key findings?", "Show me a chart of the main results", "Summarize the top takeaways"];
      shuffle(list).slice(0, 4).forEach(function (q, i) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ib-wave-chip";
        btn.style.setProperty("--ib-wave-delay", (i * 0.4) + "s");
        btn.textContent = q;
        btn.addEventListener("click", function () {
          row.remove();
          sendMessage(q);
        });
        chipWrap.appendChild(btn);
      });
      row.appendChild(chipWrap);

      els.messages.appendChild(row);
      maybeAutoScroll();
    }
    function getInitials(name) {
      if (!name) return "?";
      var words = name.trim().split(/\s+/).slice(0, 2);
      return words.map(function (w) { return w.charAt(0).toUpperCase(); }).join("");
    }

    // -------------------------------------------------------------------
    // Status indicator
    // -------------------------------------------------------------------
    var STATUS_MESSAGES = ["Thinking 🤔...", "Checking the details 🧠...", "Looking into it 💭..."];
    function typingIndicator() {
      var bubble = createRow("bot");
      bubble.innerHTML =
        '<div class="ib-typing-row"><span class="ib-dot"></span><span class="ib-dot"></span><span class="ib-dot"></span><span class="ib-status-text">Thinking...</span></div><div class="ib-status-track"><div class="ib-status-fill"></div></div>';
      var statusEl = bubble.querySelector(".ib-status-text");
      var idx = 0;
      var intervalId = setInterval(function () {
        idx = (idx + 1) % STATUS_MESSAGES.length;
        statusEl.textContent = STATUS_MESSAGES[idx];
      }, 2000);
      bubble.dataset.statusIntervalId = String(intervalId);
      return bubble;
    }
    function stopStatusCycle(bubble) {
      var id = bubble && bubble.dataset && bubble.dataset.statusIntervalId;
      if (id) clearInterval(Number(id));
    }

    // -------------------------------------------------------------------
    // Follow-ups: prefer the model's own dynamically-generated followups
    // (parsed out of its response — works for ANY tenant/dataset without
    // manual curation). If the model doesn't comply, fall back to (1) word-
    // overlap scoring against the tenant's static suggested_questions, and
    // only if THAT finds nothing relevant, (2) synthesize questions from
    // notable terms actually present in the answer, rather than a pure
    // random pick — so "no good match" still feels grounded, not arbitrary.
    // -------------------------------------------------------------------
    var STOPWORDS = ["the", "a", "an", "of", "and", "or", "is", "are", "was", "were", "in", "on", "for", "to", "by", "with", "as", "what", "whats", "how", "show", "me", "does", "do", "compare", "vs", "this", "that", "these", "those", "it", "its", "at", "be", "has", "have", "had", "we", "you", "your", "our"];
    function tokenize(str) {
      return (str || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(function (w) { return w.length >= 2 && STOPWORDS.indexOf(w) === -1; });
    }
    function shuffle(arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    }
    // Pulls out notable capitalized phrases (e.g. "Downtown Flagship", "Healthcare")
    // and number+label pairs (e.g. "4.4 satisfaction") from the raw answer text —
    // used only as a last-resort seed for synthesized follow-ups.
    function extractNotableTerms(text) {
      var seen = {};
      var terms = [];
      var capPhraseRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;
      var m;
      while ((m = capPhraseRe.exec(text)) !== null) {
        var term = m[1].replace(/^(The|A|An)\s+/, "");
        var key = term.toLowerCase();
        if (!seen[key] && term.length > 3 && ["The", "This", "That", "Show", "What"].indexOf(term) === -1) {
          seen[key] = true;
          terms.push(term);
        }
      }
      return terms.slice(0, 5);
    }
    function synthesizeFollowups(contextText, count, excludeLower) {
      var terms = extractNotableTerms(contextText || "");
      var out = [];
      terms.forEach(function (term) {
        var q = "Tell me more about " + term;
        if (excludeLower.indexOf(q.toLowerCase()) === -1 && out.indexOf(q) === -1) out.push(q);
      });
      return out.slice(0, count);
    }
    function pickFollowupsFallback(count, contextText) {
      var askedLower = conversation.filter(function (m) { return m.role === "user"; }).map(function (m) { return m.content.trim().toLowerCase(); });
      var pool = tenantConfig.suggestedQuestions.filter(function (q) { return askedLower.indexOf(q.toLowerCase()) === -1; });
      if (pool.length < count) pool = tenantConfig.suggestedQuestions;

      var contextTokens = tokenize(contextText || "");
      var scored = pool.map(function (q) {
        var qTokens = tokenize(q);
        var score = qTokens.reduce(function (sum, t) { return sum + (contextTokens.indexOf(t) !== -1 ? 1 : 0); }, 0);
        return { text: q, score: score };
      }).sort(function (a, b) { return b.score - a.score; });
      var topScore = scored[0] ? scored[0].score : 0;

      if (topScore > 0) {
        var byScore = {};
        scored.forEach(function (q) { byScore[q.score] = byScore[q.score] || []; byScore[q.score].push(q); });
        var scores = Object.keys(byScore).map(Number).sort(function (a, b) { return b - a; });
        var ordered = [];
        scores.forEach(function (s) { ordered = ordered.concat(shuffle(byScore[s])); });
        return ordered.slice(0, count).map(function (q) { return q.text; });
      }

      // No overlap found in the curated pool — synthesize from the answer's own
      // notable terms instead of returning a fully arbitrary random pick.
      var synthesized = synthesizeFollowups(contextText, count, askedLower);
      if (synthesized.length >= count) return synthesized;
      var filler = shuffle(pool).slice(0, count - synthesized.length);
      return synthesized.concat(filler);
    }
    function renderFollowupChips(afterEl, modelFollowups, contextText) {
      // Array.isArray, not truthiness — [] and "not provided at all" must be
      // distinguishable. Before this fix they weren't: {"followups": []}
      // (explicit "there are genuinely no followups here" — e.g. right
      // after a booking form, where chips would just distract from the
      // form itself) fell through to the SAME fallback-question generator
      // as a response that never mentioned followups at all, so an
      // intentionally silent response ended up with chips anyway.
      var suggestions = Array.isArray(modelFollowups)
        ? modelFollowups.slice(0, 3)
        : pickFollowupsFallback(3, contextText);
      if (!suggestions || !suggestions.length) return;
      var chipWrap = document.createElement("div");
      chipWrap.className = "ib-chips";
      suggestions.forEach(function (q) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ib-chip";
        btn.textContent = q;
        btn.addEventListener("click", function () {
          chipWrap.remove();
          sendMessage(q);
        });
        chipWrap.appendChild(btn);
      });
      afterEl.appendChild(chipWrap);
      maybeAutoScroll();
    }

    // -------------------------------------------------------------------
    // Charts
    // -------------------------------------------------------------------
    var CHART_COLORS = ["#809a39", "#4c7a24", "#b7b64a", "var(--ib-text)", "#0a2f09", "#dc2626", "#6366f1", "#4f46e5", "#10b981", "#f59e0b"];
    function buildChartDatasets(config) {
      return (config.datasets || []).map(function (ds, i) {
        var color = CHART_COLORS[i % CHART_COLORS.length];
        var isPie = config.chartType === "pie";
        var isDoughnut = config.chartType === "doughnut";
        var isPolar = config.chartType === "polarArea";
        var isRadar = config.chartType === "radar";
        var isCircular = isPie || isDoughnut || isPolar;
        return {
          label: ds.label || "Series " + (i + 1),
          data: ds.data || [],
          backgroundColor: isCircular ? (ds.data || []).map(function (_, j) { return CHART_COLORS[j % CHART_COLORS.length]; }) : color + "cc",
          borderColor: color,
          borderWidth: (isRadar || config.chartType === "line") ? 2 : 1,
          tension: 0.3,
          fill: config.chartType !== "line" && !isRadar,
        };
      });
    }
    function copyCanvasImage(canvas, btn) {
      canvas.toBlob(function (blob) {
        if (!blob) return;
        if (navigator.clipboard && window.ClipboardItem) {
          navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })])
            .then(function () { flashCheck(btn); })
            .catch(function () { downloadBlob(blob); flashCheck(btn); });
        } else {
          downloadBlob(blob);
          flashCheck(btn);
        }
      }, "image/png");
    }
    function downloadBlob(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "chart.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    function flashCheck(btn) {
      var original = btn.innerHTML;
      btn.innerHTML = ICON_CHECK;
      setTimeout(function () { btn.innerHTML = original; }, 1200);
    }
    function renderChartCanvas(config) {
      var wrap = document.createElement("div");
      wrap.className = "ib-chart-wrap";

      var titleEl = null;
      if (config.title) {
        titleEl = document.createElement("div");
        titleEl.className = "ib-chart-title";
        titleEl.textContent = config.title;
        wrap.appendChild(titleEl);
      }

      var canvas = document.createElement("canvas");
      canvas.height = 220;
      wrap.appendChild(canvas);

      var chartType = ["bar", "pie", "line", "doughnut", "radar", "polarArea"].indexOf(config.chartType) !== -1 ? config.chartType : "bar";
      var isCircular = chartType === "pie" || chartType === "doughnut" || chartType === "polarArea";
      var isRadar = chartType === "radar";
      var datasets = buildChartDatasets(config);
      var labels = config.labels || [];
      if (!datasets.length || !labels.length) {
        wrap.innerHTML = "<div class=\"ib-chart-fallback\">⚠️ Chart data is incomplete.</div>";
        return wrap;
      }
      var scaleOptions = {};
      if (!isCircular && !isRadar) {
        var yScale = { beginAtZero: true, ticks: { font: { size: 10 }, color: "#000" }, grid: { color: "rgba(0,0,0,0.06)" } };
        if (config.yLabel) yScale.title = { display: true, text: config.yLabel, font: { size: 10 }, color: "#000" };
        var xScale = { ticks: { font: { size: 10 }, color: "#000" }, grid: { display: false } };
        if (config.xLabel) xScale.title = { display: true, text: config.xLabel, font: { size: 10 }, color: "#000" };
        scaleOptions = { y: yScale, x: xScale };
      }
      if (isRadar) {
        scaleOptions = { r: { ticks: { font: { size: 9 }, color: "#000", backdropColor: "transparent" }, grid: { color: "rgba(0,0,0,0.08)" }, pointLabels: { font: { size: 10 }, color: "#000" } } };
      }
      try {
        new window.Chart(canvas.getContext("2d"), {
          type: chartType,
          data: { labels: labels, datasets: datasets },
          options: {
            responsive: true,
            plugins: {
              legend: { display: datasets.length > 1 || isCircular, labels: { boxWidth: 12, font: { size: 10 } } },
              tooltip: { enabled: true },
            },
            scales: scaleOptions,
          },
        });
      } catch (err) {
        console.error("Visa Assistant chart error:", err);
        wrap.innerHTML = "<div class=\"ib-chart-fallback\">⚠️ Couldn't render chart. Try refreshing the page.</div>";
      }
      return wrap;
    }

    // -------------------------------------------------------------------
    // Automation forms: a sibling of the chart mechanism above — a
    // renderForm JSON marker instead of renderChart. Every field starts
    // blank. Client-side required-field check is instant UX feedback
    // only; POST /api/automation-submit on the backend is the actual
    // validation boundary and re-checks everything server-side.
    // -------------------------------------------------------------------
    function renderFormUI(config) {
      var wrap = document.createElement("div");
      wrap.className = "ib-form-wrap";

      if (config.title) {
        var titleEl = document.createElement("div");
        titleEl.className = "ib-form-title";
        titleEl.textContent = config.title;
        wrap.appendChild(titleEl);
      }

      var fields = Array.isArray(config.fields) ? config.fields : [];
      var inputEls = {};
      var errorEls = {};

      fields.forEach(function (field) {
        var row = document.createElement("div");
        row.className = "ib-form-row";

        var label = document.createElement("label");
        label.className = "ib-form-label";
        label.textContent = field.label + (field.required ? " *" : "");
        row.appendChild(label);

        var input;
        if (Array.isArray(field.options) && field.options.length > 0) {
          input = document.createElement("select");
          input.className = "ib-form-input";
          var blankOpt = document.createElement("option");
          blankOpt.value = "";
          blankOpt.textContent = "Select a time…";
          input.appendChild(blankOpt);
          field.options.forEach(function (opt) {
            var o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            input.appendChild(o);
          });
        } else {
          input = document.createElement("input");
          input.type = "text";
          input.className = "ib-form-input";
          input.maxLength = 500;
        }
        input.value = ""; // every field starts blank, always
        row.appendChild(input);
        inputEls[field.key] = input;

        var errEl = document.createElement("div");
        errEl.className = "ib-form-error";
        errEl.style.display = "none";
        row.appendChild(errEl);
        errorEls[field.key] = errEl;

        wrap.appendChild(row);
      });

      var submitRow = document.createElement("div");
      submitRow.className = "ib-form-submit-row";
      var submitBtn = document.createElement("button");
      submitBtn.type = "button";
      submitBtn.className = "ib-form-submit-btn";
      submitBtn.textContent = "Submit";
      var genericError = document.createElement("div");
      genericError.className = "ib-form-error";
      genericError.style.display = "none";
      submitRow.appendChild(submitBtn);
      submitRow.appendChild(genericError);
      wrap.appendChild(submitRow);

      function clearFieldError(key) {
        if (errorEls[key]) { errorEls[key].style.display = "none"; errorEls[key].textContent = ""; }
        if (inputEls[key]) inputEls[key].classList.remove("ib-form-input-invalid");
      }
      function setFieldError(key, message) {
        if (errorEls[key]) { errorEls[key].textContent = message; errorEls[key].style.display = "block"; }
        if (inputEls[key]) inputEls[key].classList.add("ib-form-input-invalid");
      }

      submitBtn.addEventListener("click", function () {
        // Client-side required-field check — instant feedback only, NOT
        // the security boundary. First invalid field gets focused.
        var firstInvalid = null;
        fields.forEach(function (field) {
          clearFieldError(field.key);
          var val = (inputEls[field.key].value || "").trim();
          if (field.required && !val) {
            setFieldError(field.key, field.label + " is required.");
            if (!firstInvalid) firstInvalid = inputEls[field.key];
          }
        });
        if (firstInvalid) { firstInvalid.focus(); return; }

        genericError.style.display = "none";
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting…";

        var payload = { automationId: config.automationId, tenantId: config.tenantId, sessionId: config.sessionId, fields: {} };
        fields.forEach(function (field) { payload.fields[field.key] = inputEls[field.key].value || ""; });

        var headers = { "Content-Type": "application/json" };
        if (TENANT_KEY) headers["X-Widget-Key"] = TENANT_KEY;

        fetch(API_BASE + "/api/automation-submit", { method: "POST", headers: headers, body: JSON.stringify(payload) })
          .then(function (res) {
            return res.json().then(function (data) { return { ok: res.ok, data: data }; });
          })
          .then(function (result) {
            if (!result.ok) {
              submitBtn.disabled = false;
              submitBtn.textContent = "Submit";
              if (result.data && Array.isArray(result.data.errors) && result.data.errors.length) {
                result.data.errors.forEach(function (e) { setFieldError(e.key, e.message); });
                var firstErrKey = result.data.errors[0].key;
                if (inputEls[firstErrKey]) inputEls[firstErrKey].focus();
              } else {
                genericError.textContent = (result.data && result.data.error) || "Something went wrong — please try again.";
                genericError.style.display = "block";
              }
              return;
            }

            // Success — lock the form and drop a normal assistant message
            // with the server's response into the conversation. This is a
            // plain server-authored confirmation string (executeAutomation's
            // result.message) — never model-generated, so there's nothing
            // to parse and no followups mechanism applies here.
            fields.forEach(function (field) { inputEls[field.key].disabled = true; });
            submitBtn.disabled = true;
            submitBtn.textContent = "Submitted ✓";

            var replyText = (result.data && result.data.message) || "Done.";
            var bubble = createRow("bot");
            var contentContainer = document.createElement("div");
            bubble.appendChild(contentContainer);
            renderMarkdownInto(contentContainer, replyText);
            conversation.push({ role: "assistant", content: replyText });
            persistCurrentChat();
            addCopyButton(bubble, function () { return replyText; });
            maybeAutoScroll();
          })
          .catch(function () {
            submitBtn.disabled = false;
            submitBtn.textContent = "Submit";
            genericError.textContent = "Network error — please check your connection and try again.";
            genericError.style.display = "block";
          });
      });

      return wrap;
    }

    // -------------------------------------------------------------------
    // Rendering primitives — pure rendering, no parsing. The server (see
    // lib/streamTransformer.js) now sends explicitly typed NDJSON lines
    // instead of embedding structured markers inside free text, so the
    // widget never needs to regex/brace-match JSON out of a text stream
    // again. This replaced ~140 lines of exactly that kind of parsing,
    // including a fallback for when the model forgot a required fence —
    // that whole failure class is now structurally impossible: the server
    // does the one-time extraction, the wire format is unambiguous, there
    // is nothing left for the client to get wrong.
    // -------------------------------------------------------------------
    function renderMarkdownInto(container, text) {
      if (!text || !text.trim()) return;
      var div = document.createElement("div");
      div.className = "ib-msg-content";
      var renderedHtml = typeof window.marked !== "undefined" ? window.marked.parse(text) : escapeHtml(text);
      div.innerHTML = typeof window.DOMPurify !== "undefined"
        ? window.DOMPurify.sanitize(renderedHtml, { ADD_ATTR: ["target"] })
        : escapeHtml(text); // DOMPurify failed to load — fail safe to plain text, never raw HTML
      convertLinksToButtons(div);
      container.appendChild(div);
    }
    function appendChartToContainer(container, config) {
      try {
        if (typeof window.Chart === "undefined") throw new Error("Chart.js failed to load");
        container.appendChild(renderChartCanvas(config));
      } catch (err) {
        var fallback = document.createElement("div");
        fallback.className = "ib-chart-fallback";
        fallback.textContent = "⚠️ Couldn't render chart. Try refreshing the page.";
        container.appendChild(fallback);
      }
    }
    function appendFormToContainer(container, config) {
      container.appendChild(renderFormUI(config));
    }
    // Splits a growing text buffer into complete NDJSON lines plus
    // whatever incomplete trailing fragment hasn't finished arriving yet —
    // a network chunk boundary has no reason to line up with a JSON
    // object boundary, so the incomplete tail is carried forward and
    // prepended to the next chunk rather than parsed prematurely.
    function splitCompleteLines(buffer) {
      var lines = buffer.split("\n");
      var incomplete = lines.pop(); // last element is either "" (buffer ended exactly on \n) or a partial line
      return { complete: lines.filter(function (l) { return l.length > 0; }), rest: incomplete };
    }

    // -------------------------------------------------------------------
    // Errors — always generic/friendly to the user; technical detail (if any
    // is available client-side at all) only ever goes to console.error.
    // -------------------------------------------------------------------
    function renderRetryableError(bubble, technicalDetailForConsole) {
      if (technicalDetailForConsole) console.error("Visa Assistant:", technicalDetailForConsole);
      stopStatusCycle(bubble);
      bubble.innerHTML = "";
      var errDiv = document.createElement("div");
      errDiv.className = "ib-error-text";
      errDiv.textContent = "⚠️ Sorry, something went wrong answering that. Please try again.";
      bubble.appendChild(errDiv);
      var retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.textContent = "Retry";
      retryBtn.className = "ib-retry-btn";
      retryBtn.addEventListener("click", function () {
        bubble.parentElement.parentElement.remove();
        var lastUser = null;
        for (var i = conversation.length - 1; i >= 0; i--) {
          if (conversation[i].role === "user") { lastUser = conversation[i]; break; }
        }
        if (lastUser) {
          conversation = conversation.filter(function (m) { return m !== lastUser; });
          sendMessage(lastUser.content);
        }
      });
      bubble.appendChild(retryBtn);
    }

    var GREETING_RE = /^(hi|hello|hey|hiya|yo|greetings|good morning|good afternoon|good evening)(\s+there)?[!.\s]*$/i;

    // -------------------------------------------------------------------
    // Chat persistence — save/restore/switch/delete/new
    // -------------------------------------------------------------------
    function persistCurrentChat() {
      if (conversation.length === 0) return;
      var chats = loadAllChats();
      var idx = chats.findIndex(function (c) { return c.id === activeChatId; });
      var entry = { id: activeChatId, title: chatTitleFrom(conversation), updatedAt: Date.now(), messages: conversation };
      if (idx === -1) {
        entry.createdAt = Date.now();
        chats.unshift(entry);
      } else {
        entry.createdAt = chats[idx].createdAt || Date.now();
        chats[idx] = entry;
      }
      saveAllChats(chats);
      safeStorageSet(STORAGE_KEY_ACTIVE, activeChatId);
    }
    function clearMessagesUI() {
      els.messages.innerHTML = "";
      els.messages.appendChild(els.scrollDownBtn);
    }
    function startNewChat() {
      persistCurrentChat();
      activeChatId = newChatId();
      conversation = [];
      clearMessagesUI();
      renderSuggestedQuestionsOnly(tenantConfig.suggestedQuestions);
      closeHistoryPage();
      safeStorageSet(STORAGE_KEY_ACTIVE, activeChatId);
    }
    function switchToChat(chatId) {
      persistCurrentChat();
      var chats = loadAllChats();
      var found = chats.find(function (c) { return c.id === chatId; });
      if (!found) return;
      activeChatId = chatId;
      conversation = found.messages.slice();
      clearMessagesUI();
      replayConversationIntoUI();
      closeHistoryPage();
      safeStorageSet(STORAGE_KEY_ACTIVE, activeChatId);
    }
    function deleteChat(chatId, evt) {
      if (evt) evt.stopPropagation();
      var chats = loadAllChats().filter(function (c) { return c.id !== chatId; });
      saveAllChats(chats);
      if (chatId === activeChatId) {
        if (chats.length > 0) {
          switchToChat(chats[0].id);
        } else {
          activeChatId = newChatId();
          conversation = [];
          clearMessagesUI();
          renderSuggestedQuestionsOnly(tenantConfig.suggestedQuestions);
          safeStorageSet(STORAGE_KEY_ACTIVE, activeChatId);
        }
      }
      renderHistoryList();
    }
    function replayConversationIntoUI() {
      conversation.forEach(function (m) {
        if (m.role === "user") {
          renderUserMessage(m.content);
        } else {
          var bubble = createRow("bot");
          var contentContainer = document.createElement("div");
          bubble.appendChild(contentContainer);
          // Backward-compat: chat history persisted before the NDJSON
          // wire-format migration may still have an old-style trailing
          // fenced JSON block embedded directly in `content`. Strip it
          // defensively so old history doesn't show raw JSON — messages
          // saved going forward never have this, `content` is pure text.
          var cleanContent = (m.content || "").replace(/```json[\s\S]*?```\s*$/, "").trim();
          renderMarkdownInto(contentContainer, cleanContent);
          if (m.chart) appendChartToContainer(contentContainer, m.chart);
          if (m.form) appendFormToContainer(contentContainer, m.form);
          addCopyButton(bubble, function (text) { return function () { return text; }; }(cleanContent));
          if (!m.form && m.followups && m.followups.length) {
            renderFollowupChips(bubble.parentElement, m.followups, cleanContent);
          }
        }
      });
      scrollToBottomForce();
    }
    function restoreOrStartChat() {
      var savedActive = safeStorageGet(STORAGE_KEY_ACTIVE);
      var chats = loadAllChats();
      if (savedActive) {
        var found = chats.find(function (c) { return c.id === savedActive; });
        if (found && found.messages && found.messages.length > 0) {
          activeChatId = savedActive;
          conversation = found.messages.slice();
          replayConversationIntoUI();
          return;
        }
      }
      activeChatId = newChatId();
      conversation = [];
      renderSuggestedQuestionsOnly(tenantConfig.suggestedQuestions);
    }
    function formatRelativeDate(ts) {
      var diffMs = Date.now() - ts;
      var mins = Math.floor(diffMs / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return mins + "m ago";
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + "h ago";
      var days = Math.floor(hrs / 24);
      if (days < 7) return days + "d ago";
      return new Date(ts).toLocaleDateString();
    }
    function renderHistoryList() {
      var chats = loadAllChats();
      els.historyList.innerHTML = "";
      if (chats.length === 0) {
        var empty = document.createElement("div");
        empty.className = "ib-history-empty";
        empty.innerHTML = '<div class="ib-history-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8-1.06 0-2.077-.163-3.02-.465L3 21l1.395-4.184C3.512 15.767 3 14.42 3 13c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg></div><div class="ib-history-empty-title">No chat history yet</div><div class="ib-history-empty-text">Your conversations will appear here</div>';
        els.historyList.appendChild(empty);
        return;
      }
      var now = Date.now();
      var today = [];
      var previous = [];
      chats.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).forEach(function (c) {
        var chatDate = new Date(c.updatedAt || c.createdAt || now);
        var isToday = chatDate.toDateString() === new Date(now).toDateString();
        if (isToday) { today.push(c); } else { previous.push(c); }
      });
      function renderSection(title, list) {
        if (list.length === 0) return;
        var section = document.createElement("div");
        section.className = "ib-history-section";
        var header = document.createElement("div");
        header.className = "ib-history-section-header";
        header.textContent = title;
        section.appendChild(header);
        list.forEach(function (c) {
          var item = document.createElement("div");
          item.className = "ib-history-item" + (c.id === activeChatId ? " ib-active" : "");
          var icon = document.createElement("div");
          icon.className = "ib-history-item-icon";
          icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8-1.06 0-2.077-.163-3.02-.465L3 21l1.395-4.184C3.512 15.767 3 14.42 3 13c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>';
          var info = document.createElement("div");
          info.className = "ib-history-item-info";
          var titleEl = document.createElement("div");
          titleEl.className = "ib-history-item-title";
          titleEl.textContent = c.title || "New chat";
          var metaEl = document.createElement("div");
          metaEl.className = "ib-history-item-meta";
          metaEl.textContent = formatRelativeDate(c.updatedAt || c.createdAt || now);
          info.appendChild(titleEl);
          info.appendChild(metaEl);
          var menuBtn = document.createElement("button");
          menuBtn.type = "button";
          menuBtn.className = "ib-history-item-menu";
          menuBtn.innerHTML = ICON_TRASH;
          menuBtn.title = "Delete this chat";
          menuBtn.addEventListener("click", function (e) { e.stopPropagation(); deleteChat(c.id, e); });
          item.appendChild(icon);
          item.appendChild(info);
          item.appendChild(menuBtn);
          item.addEventListener("click", function () { switchToChat(c.id); closeHistoryPage(); });
          section.appendChild(item);
        });
        els.historyList.appendChild(section);
      }
      renderSection("Today", today);
      renderSection("Previous", previous);
    }
    function openHistoryPage() {
      els.historyPage.classList.add("ib-show");
      renderHistoryList();
    }
    function closeHistoryPage() {
      els.historyPage.classList.remove("ib-show");
    }
    function toggleHistoryPage() {
      var showing = els.historyPage.classList.contains("ib-show");
      if (showing) { closeHistoryPage(); return; }
      openHistoryPage();
    }
    els.newChatBtn.addEventListener("click", startNewChat);
    els.historyBtn.addEventListener("click", toggleHistoryPage);
    els.historyBackBtn.addEventListener("click", closeHistoryPage);
    els.historyNewChatBtn.addEventListener("click", function () {
      closeHistoryPage();
      startNewChat();
    });

    // -------------------------------------------------------------------
    // Send + stream
    // -------------------------------------------------------------------
    function fetchChatStream(payload, signal) {
      var body = JSON.stringify(payload);
      var headers = { "Content-Type": "application/json" };
      if (TENANT_KEY) headers["X-Widget-Key"] = TENANT_KEY;
      return fetch(API_BASE + "/api/chat", { method: "POST", headers: headers, body: body, signal: signal })
        .catch(function (err) {
          if (err.name === "AbortError") throw err;
          return new Promise(function (resolve) { setTimeout(resolve, 800); }).then(function () {
            return fetch(API_BASE + "/api/chat", { method: "POST", headers: headers, body: body, signal: signal });
          });
        });
    }

    function sendMessage(text) {
      if (!text || isStreaming) return;
      text = text.slice(0, MAX_INPUT_LENGTH);

      var welcomeEl = document.getElementById("ib-welcome");
      if (welcomeEl) welcomeEl.remove();

      renderUserMessage(text);
      conversation.push({ role: "user", content: text });
      persistCurrentChat();
      scrollToBottomForce();

      if (GREETING_RE.test(text.trim())) {
        var greetBubble = createRow("bot");
        greetBubble.innerHTML = '<div class="ib-msg-content">👋 What would you like to know?</div>';
        conversation.push({ role: "assistant", content: "What would you like to know?" });
        persistCurrentChat();
        renderFollowupChips(greetBubble.parentElement, null, "");
        return;
      }

      if (missingLibs.length > 0) {
        var b = createRow("bot");
        b.innerHTML = '<div class="ib-error-text">⚠️ Couldn\'t load required libraries. Check your connection or ad-blocker settings, then refresh.</div>';
        return;
      }

      setStreamingUI(true);
      currentAbortController = new AbortController();
      var thinkingBubble = typingIndicator();

      fetchChatStream({ messages: conversation, sessionId: TENANT_ID + "_" + activeChatId, tenantId: TENANT_ID }, currentAbortController.signal)
        .then(function (res) {
          if (!res.ok || !res.body) {
            renderRetryableError(thinkingBubble, "HTTP " + res.status);
            setStreamingUI(false);
            return null;
          }

          stopStatusCycle(thinkingBubble);
          thinkingBubble.innerHTML = "";
          var contentContainer = document.createElement("div");
          thinkingBubble.appendChild(contentContainer);
          var textDiv = null; // created lazily on the first text delta

          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var lineBuffer = "";
          var visibleText = "";
          var chartConfig = null;
          var formConfig = null;
          var followupsReceived = null;

          function updateTextDiv() {
            if (!visibleText.trim()) return;
            if (!textDiv) {
              textDiv = document.createElement("div");
              textDiv.className = "ib-msg-content";
              contentContainer.insertBefore(textDiv, contentContainer.firstChild);
            }
            var renderedHtml = typeof window.marked !== "undefined" ? window.marked.parse(visibleText) : escapeHtml(visibleText);
            textDiv.innerHTML = typeof window.DOMPurify !== "undefined"
              ? window.DOMPurify.sanitize(renderedHtml, { ADD_ATTR: ["target"] })
              : escapeHtml(visibleText);
            convertLinksToButtons(textDiv);
          }

          // Returns true once a "done" line is seen — the caller stops
          // pumping at that point rather than waiting on the underlying
          // HTTP stream to close on its own.
          function processLine(line) {
            var msg = null;
            try { msg = JSON.parse(line); } catch (e) { return false; } // malformed line — skip rather than crash the stream
            if (msg.type === "text") {
              visibleText += msg.delta || "";
              updateTextDiv();
            } else if (msg.type === "chart") {
              chartConfig = msg.config;
              appendChartToContainer(contentContainer, msg.config);
            } else if (msg.type === "form") {
              formConfig = msg.config;
              appendFormToContainer(contentContainer, msg.config);
            } else if (msg.type === "followups") {
              followupsReceived = Array.isArray(msg.items) ? msg.items : [];
            } else if (msg.type === "done") {
              return true;
            }
            return false;
          }

          function finalize() {
            var hasForm = !!formConfig;
            if (visibleText.trim().length === 0 && !hasForm && !chartConfig) {
              renderRetryableError(thinkingBubble, "empty response");
            } else {
              conversation.push({ role: "assistant", content: visibleText, followups: followupsReceived, chart: chartConfig, form: formConfig });
              persistCurrentChat();
              addCopyButton(thinkingBubble, function () { return visibleText; });
              if (!hasForm) renderFollowupChips(thinkingBubble.parentElement, followupsReceived, text + " " + visibleText);
            }
            setStreamingUI(false);
            currentAbortController = null;
            maybeAutoScroll();
          }

          function pump() {
            return reader.read().then(function (result) {
              if (result.done) {
                if (lineBuffer.trim()) processLine(lineBuffer); // trailing line with no final \n
                finalize();
                return;
              }
              lineBuffer += decoder.decode(result.value, { stream: true });
              var split = splitCompleteLines(lineBuffer);
              lineBuffer = split.rest;
              for (var i = 0; i < split.complete.length; i++) {
                if (processLine(split.complete[i])) { finalize(); return; }
              }
              maybeAutoScroll();
              return pump();
            });
          }
          return pump();
        })
        .catch(function (err) {
          if (err.name === "AbortError") {
            stopStatusCycle(thinkingBubble);
            setStreamingUI(false);
            currentAbortController = null;
            maybeAutoScroll();
            return;
          }
          renderRetryableError(thinkingBubble, err.message);
          setStreamingUI(false);
          currentAbortController = null;
        });
    }

    loadTenantConfig();
  }

  function boot() {
    injectStyles();
    buildMarkup();
    ensureDependencies().then(initWidget).catch(initWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
