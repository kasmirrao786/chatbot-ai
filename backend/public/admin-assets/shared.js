// Renders the persistent sidebar + status rail shared by every admin page,
// and a couple of tiny UI helpers (toast). Each page calls
// AdminShell.mount({ active, title, subtitle }) once, near the top of its
// own script, then continues with its existing page-specific logic —
// this only owns the app chrome, not any page's actual functionality.
const AdminShell = (() => {
  const NAV_ITEMS = [
    { key: "tenants", href: "/admin", label: "Tenants", icon: iconTenants() },
    { key: "knowledge", href: "/admin/knowledge", label: "Knowledge Base", icon: iconKnowledge() },
    { key: "automations", href: "/admin/automations", label: "Automations", icon: iconAutomations() },
    { key: "analytics", href: "/admin/analytics", label: "Leads & Analytics", icon: iconAnalytics() },
  ];

  function mount({ active, title, subtitle, actions }) {
    const shell = document.createElement("div");
    shell.className = "app-shell";
    shell.innerHTML = `
      <aside class="sidebar" id="adminSidebar">
        <div class="sidebar-brand">
          <div class="mark">IB</div>
          <div>
            <div class="name">Visa Assistant</div>
            <div class="sub">Admin Console</div>
          </div>
        </div>
        <nav class="sidebar-nav">
          ${NAV_ITEMS.map((item) => `
            <a class="nav-item${item.key === active ? " active" : ""}" href="${item.href}">
              ${item.icon}<span>${item.label}</span>
            </a>`).join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="status-rail" id="statusRail">
            <div class="status-row"><span class="status-dot"></span> Checking status…</div>
          </div>
          <a class="logout-link" id="logoutLink" href="#">Log out</a>
        </div>
      </aside>
      <div class="app-main">
        <div class="topbar">
          <div>
            <h1>${title}</h1>
            ${subtitle ? `<div class="page-sub">${subtitle}</div>` : ""}
          </div>
          <div class="topbar-actions" id="topbarActions">${actions || ""}</div>
        </div>
        <div class="content" id="adminContent"></div>
      </div>
      <div class="toast" id="adminToast"></div>
    `;
    // Move any existing body content (pages that still have inline markup
    // at mount time) into #adminContent, then swap the shell in.
    const existing = [...document.body.childNodes];
    document.body.innerHTML = "";
    document.body.appendChild(shell);
    const contentEl = document.getElementById("adminContent");
    existing.forEach((node) => contentEl.appendChild(node));

    document.getElementById("logoutLink").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await fetch("/api/admin/logout", { method: "POST" });
      } finally {
        window.location.href = "/admin/login";
      }
    });

    loadStatus();
    return contentEl;
  }

  async function loadStatus() {
    const rail = document.getElementById("statusRail");
    if (!rail) return;
    try {
      const res = await fetch("/api/admin/status");
      if (!res.ok) throw new Error("status check failed");
      const { status } = await res.json();
      const rows = [
        ["Database", status.db],
        ["Redis", status.redis],
        ["KB Service", status.kbService],
      ];
      rail.innerHTML = rows
        .map(([label, state]) => `<div class="status-row"><span class="status-dot ${state}"></span> ${label} — ${stateLabel(state)}</div>`)
        .join("");
    } catch {
      rail.innerHTML = `<div class="status-row"><span class="status-dot error"></span> Status unavailable</div>`;
    }
  }

  function stateLabel(state) {
    if (state === "connected") return "connected";
    if (state === "error") return "unreachable";
    return "not set up";
  }

  function toast(message, type = "ok") {
    const el = document.getElementById("adminToast");
    if (!el) return;
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = "toast"; }, 3200);
  }

  function iconTenants() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 4v16"/></svg>`;
  }
  function iconKnowledge() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
  }
  function iconAutomations() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>`;
  }
  function iconAnalytics() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/></svg>`;
  }

  // Generic modal — first used by the conversation transcript viewer
  // (Leads & Analytics), written generically so any future "show a
  // detail view over the current page" need can reuse it rather than
  // each page building its own overlay.
  function openModal({ title, subtitle, bodyHtml }) {
    closeModal(); // only one at a time
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.id = "adminModalBackdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h3>${title}</h3>
            ${subtitle ? `<div class="sub">${subtitle}</div>` : ""}
          </div>
          <button class="modal-close" aria-label="Close">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
      </div>
    `;
    document.body.appendChild(backdrop);
    // rAF so the .open transition actually plays instead of snapping in
    requestAnimationFrame(() => backdrop.classList.add("open"));
    backdrop.querySelector(".modal-close").addEventListener("click", closeModal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
    document.addEventListener("keydown", escHandler);
  }

  function closeModal() {
    const el = document.getElementById("adminModalBackdrop");
    if (el) el.remove();
    document.removeEventListener("keydown", escHandler);
  }

  function escHandler(e) {
    if (e.key === "Escape") closeModal();
  }

  function escHtml(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Renders a session's log entries as an actual chat transcript (user/
  // assistant bubbles, chronological) instead of the flat data-table row
  // they came from — used by both the Tenants page's log tabs and the
  // Analytics page's recent-activity table, so it lives here once rather
  // than being copy-pasted into each. Self-contained (own fetch, own
  // escaping) so it doesn't depend on whatever local api()/esc() helper
  // each page happens to define.
  async function openConversationTranscript(sessionId, tenantId) {
    openModal({
      title: "Conversation",
      subtitle: `${escHtml(tenantId || "")} · session ${escHtml(sessionId)}`,
      bodyHtml: '<div class="empty">Loading…</div>',
    });
    const bodyEl = document.querySelector("#adminModalBackdrop .modal-body");
    try {
      const res = await fetch(`/api/admin/logs?type=conversations&sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      if (!data.entries.length) {
        bodyEl.innerHTML = '<div class="empty">No messages found for this session.</div>';
        return;
      }
      bodyEl.innerHTML = `<div class="transcript">${data.entries.map(renderTranscriptTurn).join("")}</div>`;
    } catch (err) {
      bodyEl.innerHTML = `<div class="empty">Failed to load: ${escHtml(err.message)}</div>`;
    }
  }

  function renderTranscriptTurn(e) {
    const time = e.timestamp ? new Date(e.timestamp).toLocaleString() : "";
    const metaBits = [time];
    if (typeof e.durationMs === "number") metaBits.push(`${e.durationMs}ms`);
    if (typeof e.estimatedCostUsd === "number") metaBits.push(`$${e.estimatedCostUsd.toFixed(5)}`);
    if (e.guardrail) metaBits.push('<span class="flag">guardrail</span>');
    const userPart = e.userMessage
      ? `<div class="bubble-row user"><div class="bubble user">${escHtml(e.userMessage)}</div></div>
         <div class="transcript-meta user">${escHtml(time)}</div>`
      : "";
    const assistantPart = e.assistantResponse
      ? `<div class="bubble-row assistant"><div class="bubble assistant">${escHtml(e.assistantResponse)}</div></div>
         <div class="transcript-meta">${metaBits.filter(Boolean).map((m, i) => i === 0 ? escHtml(m) : m).join(" · ")}</div>`
      : "";
    return `<div class="transcript-turn">${userPart}${assistantPart}</div>`;
  }

  return { mount, toast, loadStatus, openModal, closeModal, openConversationTranscript };
})();
