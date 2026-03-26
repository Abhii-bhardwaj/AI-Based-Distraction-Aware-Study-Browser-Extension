function showScreen(id) {
  document
    .querySelectorAll(".screen")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ── CONSENT ACTIONS ───────────────────────────────────────────
document.getElementById("btn-start").addEventListener("click", () => {
  chrome.storage.local.set(
    { trackingEnabled: true, sessionStartTime: Date.now() },
    () => {
      showScreen("screen-live");
      startPolling();
    },
  );
});

document.getElementById("btn-cancel").addEventListener("click", () => {
  window.close();
});

// ── END SESSION ───────────────────────────────────────────────
document.getElementById("btn-end").addEventListener("click", () => {
  stopPolling();
  chrome.storage.local.set({ trackingEnabled: false }, () => {
    chrome.storage.local.get("liveData", ({ liveData }) => {
      if (liveData) {
        document.getElementById("summary-score").textContent =
          liveData.focusScore ?? "—";
        document.getElementById("summary-duration").textContent =
          (liveData.sessionDuration ?? "—") + " min";
        document.getElementById("summary-streak").textContent =
          (liveData.longestStreak ?? "—") + " min";
        document.getElementById("summary-interventions").textContent =
          liveData.interventionCount ?? "—";
        document.getElementById("summary-compliance").textContent =
          liveData.complianceRate != null ? liveData.complianceRate + "%" : "—";
        const score = liveData.focusScore || 0;
        document.getElementById("summary-score").style.color =
          score >= 70
            ? "var(--green)"
            : score >= 40
              ? "var(--amber)"
              : "var(--red)";
      }
      showScreen("screen-summary");
    });
  });
});

document.getElementById("btn-new-session").addEventListener("click", () => {
  chrome.storage.local.set({ trackingEnabled: false }, () => {
    showScreen("screen-consent");
  });
});

// ── OVERRIDE BUTTON ───────────────────────────────────────────
document.getElementById("btn-override").addEventListener("click", async () => {
  // Increment override count directly in storage
  const { swState } = await chrome.storage.local.get("swState");
  if (swState) {
    swState.overrideCount = (swState.overrideCount || 0) + 1;
    await chrome.storage.local.set({ swState });
  }
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      disableRulesetIds: ["distraction_rules", "research_mode_rules"],
    });
  } catch (e) {}
  document.getElementById("btn-override").style.display = "none";
});

// ── THEME TOGGLE (GLOBAL) ──────────────────────────────────
const themeBtn = document.getElementById('themeToggleBtn');
const root = document.documentElement;

function applyTheme(theme) {
  if (theme === 'light') {
    root.classList.add('light-theme');
    if (themeBtn) themeBtn.innerHTML = '🌙 Night';
  } else {
    root.classList.remove('light-theme');
    if (themeBtn) themeBtn.innerHTML = '🌞 Day';
  }
}

async function setTheme(light) {
  const theme = light ? 'light' : 'dark';
  await chrome.storage.local.set({ theme });
  applyTheme(theme);
  // Notify all extension pages
  chrome.runtime.sendMessage({ type: 'THEME_CHANGED', theme });
}

if (themeBtn) {
  themeBtn.addEventListener('click', async () => {
    const current = root.classList.contains('light-theme');
    await setTheme(!current);
  });
}

// On load, apply theme from chrome.storage.local
chrome.storage.local.get('theme', ({ theme }) => {
  applyTheme(theme === 'light' ? 'light' : 'dark');
});

// Listen for theme changes from other pages
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'THEME_CHANGED') {
    applyTheme(msg.theme);
  }
});

// ── LIVE UI UPDATE ─────────────────────────────────────────────
const SIGNAL_LABELS = {
  tabSwitchFreq: ["Tab switch freq", false],
  tabSwitchSpeed: ["Tab switch speed", true],
  burstSwitchCount: ["Burst switches", true],
  idleDuration: ["Idle time", false],
  scrollIrregularity: ["Scroll irregularity", false],
  scrollJerk: ["Scroll jerk", true],
  keystrokeVariance: ["Keystroke variance", false],
  mouseVelocity: ["Mouse velocity", true],
  domainRevisitFreq: ["Distract. domains", false],
  notifOpenSpeed: ["Notif response", true],
  timeOfDayWeight: ["Time of day", false],
};

const TIER_CONFIG = {
  0: { chip: "Focused", cls: "tier-0", color: "var(--green)", alert: null },
  1: {
    chip: "Warning",
    cls: "tier-1",
    color: "var(--amber)",
    alert: "Focus alert — refocus now.",
  },
  2: {
    chip: "Research mode",
    cls: "tier-2",
    color: "var(--orange)",
    alert: "Social media blocked. Academic sites only.",
  },
  3: {
    chip: "Full focus mode",
    cls: "tier-3",
    color: "var(--red)",
    alert: "All distracting sites blocked for 5 minutes.",
  },
};

function getBarColor(val) {
  if (val < 0.35) return "var(--green)";
  if (val < 0.65) return "var(--amber)";
  return "var(--red)";
}

function updateLiveUI(data) {
  if (!data) return;
  const dls = data.currentDLS || 0;
  const pct = Math.round(dls * 100);
  const tier = data.currentTier || 0;
  const cfg = TIER_CONFIG[tier];

  // DLS number + bar
  document.getElementById("dls-number").textContent = pct;
  document.getElementById("dls-number").style.color = cfg.color;
  document.getElementById("dls-bar").style.width = pct + "%";
  document.getElementById("dls-bar").style.background = cfg.color;

  // Tier chip
  const chip = document.getElementById("tier-chip");
  chip.textContent = cfg.chip;
  chip.className = "tier-chip " + cfg.cls;

  // Header status
  const statusPill = document.getElementById("header-status");
  const statusText = document.getElementById("status-text");
  if (tier === 3) {
    statusPill.className = "status-pill blocking";
    statusText.textContent = "blocking";
  } else {
    statusPill.className = "status-pill live";
    statusText.textContent = "live";
  }

  // Alert box
  const alertBox = document.getElementById("alert-box");
  if (cfg.alert) {
    alertBox.textContent = cfg.alert;
    alertBox.className = "alert-box tier" + tier;
  } else {
    alertBox.className = "alert-box";
  }

  // Override button
  document.getElementById("btn-override").style.display =
    tier >= 2 ? "block" : "none";

  // Stats
  document.getElementById("stat-focus").textContent = data.focusScore ?? "—";
  document.getElementById("stat-streak").textContent =
    data.longestStreak != null ? data.longestStreak + "m" : "—";
  document.getElementById("stat-interventions").textContent =
    data.interventionCount ?? "—";
  document.getElementById("stat-compliance").textContent =
    data.complianceRate != null ? data.complianceRate + "%" : "—";

  // Session timer
  document.getElementById("session-timer").textContent =
    (data.sessionDuration ?? 0) + " min active";

  // Signal rows
  if (data.features) {
    const rows = Object.entries(SIGNAL_LABELS)
      .map(([key, [label, isNew]]) => {
        const val = data.features[key] ?? 0;
        const pctBar = Math.round(val * 100);
        const color = getBarColor(val);
        return `<div class="signal-row">
        <span class="signal-name">${label}</span>
        ${isNew ? '<span class="new-badge">new</span>' : ""}
        <div class="signal-bar-track">
          <div class="signal-bar-fill" style="width:${pctBar}%;background:${color}"></div>
        </div>
        <span class="signal-val" style="color:${color}">${pctBar}%</span>
      </div>`;
      })
      .join("");
    document.getElementById("signal-rows").innerHTML = rows;
  }
}

// ── POLLING ───────────────────────────────────────────────────
let pollInterval = null;

function startPolling() {
  loadAndRender();
  pollInterval = setInterval(loadAndRender, 3000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function loadAndRender() {
  const { liveData } = await chrome.storage.local.get("liveData");
  updateLiveUI(liveData);
}

// ── INIT: check if session already active ────────────────────
(async () => {
  const { trackingEnabled } = await chrome.storage.local.get("trackingEnabled");
  if (trackingEnabled) {
    showScreen("screen-live");
    startPolling();
  }
})();
