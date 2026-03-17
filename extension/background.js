// ============================================================
// background.js — Service Worker v2
// Changes from v1:
//   - icon click opens sidePanel (not a dashboard tab)
//   - ALL scoring gated behind trackingEnabled flag
//   - New signals: tabSwitchSpeed, notifOpenSpeed, mouseVelocity, scrollJerk, burstSwitchCount
//   - notification click time tracking
//   - SESSION_START / SESSION_END messages from side panel
// ============================================================

const WINDOW_SIZE_MS = 60000;
const BACKEND_URL = "http://localhost:3001";

// ── ONNX RUNTIME ─────────────────────────────────────────────
let ortSession = null;

async function loadONNXModel() {
  try {
    importScripts('models/ort.min.js');
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('models/');
    const modelUrl = chrome.runtime.getURL('models/dls_model.onnx');
    const response = await fetch(modelUrl);
    const modelBuffer = await response.arrayBuffer();
    ortSession = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm']
    });
    console.log('[ONNX] Model loaded successfully');
  } catch (e) {
    console.warn('[ONNX] Model load failed, falling back to weighted sum:', e);
    ortSession = null;
  }
}

const DISTRACTING_DOMAINS = [
  "youtube.com","instagram.com","facebook.com","twitter.com",
  "x.com","tiktok.com","reddit.com","netflix.com","twitch.tv",
  "9gag.com","snapchat.com","discord.com"
];

const TIER1 = 0.50, TIER2 = 0.65, TIER3 = 0.78;

const DEFAULT_WEIGHTS = {
  tabSwitchFreq: 0.22, idleDuration: 0.15,
  scrollIrregularity: 0.10, keystrokeVariance: 0.12,
  domainRevisitFreq: 0.15, timeOfDayWeight: 0.05,
  tabSwitchSpeed: 0.10, notifOpenSpeed: 0.05,
  mouseVelocity: 0.03, scrollJerk: 0.02, burstSwitchCount: 0.01
};

// ── OPEN SIDE PANEL ON ICON CLICK ────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── HELPERS ──────────────────────────────────────────────────
function extractDomain(url) {
  try { return new URL(url).hostname.replace("www.", ""); }
  catch { return null; }
}
function isDistracting(domain) {
  return domain && DISTRACTING_DOMAINS.some(d => domain.includes(d));
}
function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length);
}
function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── STATE ─────────────────────────────────────────────────────
async function getState() {
  const { swState } = await chrome.storage.local.get("swState");
  if (swState) return swState;
  return buildFreshState();
}

function buildFreshState() {
  return {
    startTime: Date.now(),
    tabSwitches: [], idleEvents: [], domainVisits: {},
    keystrokeTimings: [], scrollEvents: [], mouseEvents: [],
    currentDLS: 0, currentTier: 0,
    interventionCount: 0, focusWindowsTotal: 0,
    focusWindowsDistracted: 0,
    focusStreakStart: Date.now(), longestStreak: 0,
    activeTimeMs: 0, lastActiveTimestamp: Date.now(),
    isCurrentlyIdle: false,
    notifications: [],
    prevDLS: 0,
    overrideCount: 0,
    // new v2 signals
    tabSwitchTimestamps: [],   // raw timestamps for speed calc
    notifCreateTimes: {},      // notifId -> createTime
    notifOpenSpeeds: [],       // ms to click each notification
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ swState: state });
}

function getActiveMinutes(state) {
  let total = state.activeTimeMs || 0;
  if (!state.isCurrentlyIdle && state.lastActiveTimestamp) {
    total += Date.now() - state.lastActiveTimestamp;
  }
  return Math.round(total / 60000);
}

// ── INIT ─────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove(["swState", "liveData"]);
  await chrome.storage.local.set({ trackingEnabled: false });
  await loadONNXModel();
  setupAlarms();
  await registerWithBackend();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadONNXModel();
  setupAlarms();
  // Restore tracking state (user may have had active session)
});

function setupAlarms() {
  chrome.alarms.create("scoringTick", { periodInMinutes: 1/6 }); // 10s
  chrome.alarms.create("syncBackend",  { periodInMinutes: 0.5 }); // 30s
  chrome.alarms.create("recalibrate",  { periodInMinutes: 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "scoringTick") runScoringCycle();
  if (alarm.name === "syncBackend")  syncToBackend();
  if (alarm.name === "recalibrate")  runRecalibration();
});

// ── BACKEND ──────────────────────────────────────────────────
async function registerWithBackend() {
  try {
    await fetch(`${BACKEND_URL}/api/session/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: Date.now(), startTime: new Date().toISOString() })
    });
  } catch (e) {}
}

async function syncToBackend() {
  try {
    const { liveData } = await chrome.storage.local.get(["liveData"]);
    if (!liveData) return;
    await fetch(`${BACKEND_URL}/api/session/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...liveData, timestamp: Date.now() })
    });
    const res = await fetch(`${BACKEND_URL}/api/model/weights`);
    if (res.ok) {
      const { weights } = await res.json();
      if (weights) await chrome.storage.local.set({ modelWeights: weights });
    }
  } catch (e) {}
}

// ── TAB MONITORING ───────────────────────────────────────────
chrome.tabs.onActivated.addListener(async (info) => {
  const state = await getState();
  const now = Date.now();
  const cutoff = now - 5 * 60000;

  // Tab switch speed: time since last switch
  state.tabSwitches.push(now);
  state.tabSwitches = state.tabSwitches.filter(t => t > cutoff);
  state.tabSwitchTimestamps = state.tabSwitchTimestamps || [];
  state.tabSwitchTimestamps.push(now);
  state.tabSwitchTimestamps = state.tabSwitchTimestamps.filter(t => t > cutoff);

  chrome.tabs.get(info.tabId, async (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    const domain = extractDomain(tab.url);
    if (!domain) return;
    if (!state.domainVisits[domain]) state.domainVisits[domain] = [];
    state.domainVisits[domain].push(now);
    state.domainVisits[domain] = state.domainVisits[domain].filter(t => t > cutoff);
    await saveState(state);
  });
  await saveState(state);
});

// ── NOTIFICATION CLICK TIMING ────────────────────────────────
chrome.notifications.onClicked.addListener(async (notifId) => {
  const state = await getState();
  const createTime = state.notifCreateTimes?.[notifId];
  if (createTime) {
    const openSpeed = Date.now() - createTime;
    state.notifOpenSpeeds = state.notifOpenSpeeds || [];
    state.notifOpenSpeeds.push({ speed: openSpeed, time: Date.now() });
    state.notifOpenSpeeds = state.notifOpenSpeeds.filter(e => e.time > Date.now() - 30 * 60000);
    delete state.notifCreateTimes[notifId];
  }
  // Mark notification as complied
  if (state.notifications) {
    const notif = state.notifications.find(n => notifId.includes('tier' + n.tier) && n.complied === null);
    if (notif) { notif.complied = true; notif.openedAt = Date.now(); }
  }
  await saveState(state);
});

chrome.notifications.onClosed.addListener(async (notifId, byUser) => {
  const state = await getState();
  if (state.notifCreateTimes?.[notifId]) delete state.notifCreateTimes[notifId];
  await saveState(state);
});

// ── IDLE MONITORING ───────────────────────────────────────────
chrome.idle.setDetectionInterval(30);
chrome.idle.onStateChanged.addListener(async (idleState) => {
  const state = await getState();
  const now = Date.now();
  if (idleState === "active") {
    state.isCurrentlyIdle = false;
    state.lastActiveTimestamp = now;
    const last = state.idleEvents[state.idleEvents.length - 1];
    if (last && !last.end) { last.end = now; last.duration = last.end - last.start; }
    state.idleEvents = state.idleEvents.filter(e => e.start > now - 5*60000);
  } else {
    if (!state.isCurrentlyIdle && state.lastActiveTimestamp) {
      state.activeTimeMs = (state.activeTimeMs || 0) + (now - state.lastActiveTimestamp);
    }
    state.isCurrentlyIdle = true;
    state.idleEvents.push({ start: now });
  }
  await saveState(state);
});

// ── MESSAGES ─────────────────────────────────────────────────
// ── STORAGE CHANGE LISTENER (sidepanel writes directly to storage) ──────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.trackingEnabled) {
    const enabled = changes.trackingEnabled.newValue;
    if (enabled) {
      // Session started
      (async () => {
        await chrome.storage.local.remove(["swState", "liveData"]);
        const fresh = buildFreshState();
        await saveState(fresh);
        console.log('[StudyGuard] Session started via storage — tracking enabled');
      })();
    } else {
      // Session ended
      (async () => {
        const state = await getState();
        await finalizeSessionToBackend(state);
        console.log('[StudyGuard] Session ended via storage — tracking disabled');
      })();
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // SESSION_START — legacy fallback (keep for compatibility)
  if (msg.type === "SESSION_START") {
    (async () => {
      await chrome.storage.local.remove(["swState", "liveData"]);
      const fresh = buildFreshState();
      await saveState(fresh);
      await chrome.storage.local.set({ trackingEnabled: true });
      console.log('[StudyGuard] Session started via message');
    })();
    return false;
  }

  // SESSION_END — legacy fallback
  if (msg.type === "SESSION_END") {
    (async () => {
      const state = await getState();
      await finalizeSessionToBackend(state);
      await chrome.storage.local.set({ trackingEnabled: false });
      console.log('[StudyGuard] Session ended via message');
    })();
    return false;
  }

  if (msg.type === "KEYSTROKES" || msg.type === "SCROLL" || msg.type === "MOUSE") {
    (async () => {
      const { trackingEnabled } = await chrome.storage.local.get('trackingEnabled');
      if (!trackingEnabled) return;
      const state = await getState();
      const cutoff = Date.now() - WINDOW_SIZE_MS;
      if (msg.type === "KEYSTROKES") {
        state.keystrokeTimings.push(...msg.data);
        state.keystrokeTimings = state.keystrokeTimings.filter(e => e.time > cutoff);
      }
      if (msg.type === "SCROLL") {
        state.scrollEvents.push(...msg.data);
        state.scrollEvents = state.scrollEvents.filter(e => e.time > cutoff);
      }
      if (msg.type === "MOUSE") {
        state.mouseEvents = state.mouseEvents || [];
        state.mouseEvents.push(...msg.data);
        state.mouseEvents = state.mouseEvents.filter(e => e.time > cutoff);
      }
      await saveState(state);
    })();
    return false;
  }

  if (msg.type === "GET_DLS") {
    (async () => {
      const state = await getState();
      sendResponse({ dls: state.currentDLS, tier: state.currentTier });
    })();
    return true;
  }

  if (msg.type === "RESET_SESSION") {
    (async () => {
      const state = await getState();
      await finalizeSessionToBackend(state);
      await chrome.storage.local.remove(["swState", "liveData"]);
      await chrome.storage.local.set({ trackingEnabled: false });
    })();
    return false;
  }

  if (msg.type === "OVERRIDE_BLOCK") {
    (async () => {
      const state = await getState();
      state.overrideCount = (state.overrideCount || 0) + 1;
      await saveState(state);
    })();
    return false;
  }
});

// ── FINALIZE SESSION ──────────────────────────────────────────
async function finalizeSessionToBackend(state) {
  try {
    const { liveData } = await chrome.storage.local.get("liveData");
    if (!liveData) return;
    await fetch(`${BACKEND_URL}/api/session/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.startTime, ...liveData, endTime: Date.now() })
    });
  } catch (e) {}
}

// ── FEATURE EXTRACTION (11 features) ─────────────────────────
function extractFeatures(state) {
  const now = Date.now();
  const win = now - WINDOW_SIZE_MS;

  // 1. tabSwitchFreq — how many switches per minute (normalized)
  const switches = state.tabSwitches.filter(t => t > win);
  const tabSwitchFreq = Math.min(switches.length / 10, 1.0);

  // 2. tabSwitchSpeed — avg ms between consecutive switches (fast = distracted)
  const ts = state.tabSwitchTimestamps || [];
  const recentTs = ts.filter(t => t > win);
  let tabSwitchSpeed = 0;
  if (recentTs.length >= 2) {
    const intervals = [];
    for (let i = 1; i < recentTs.length; i++) intervals.push(recentTs[i] - recentTs[i-1]);
    const avgInterval = average(intervals);
    // Normalize: 500ms = fully distracted (1.0), 30000ms = calm (0.0)
    tabSwitchSpeed = Math.max(0, Math.min(1, 1 - (avgInterval - 500) / 29500));
  }

  // 3. burstSwitchCount — switches under 1500ms apart (rapid bursts)
  let burstCount = 0;
  for (let i = 1; i < recentTs.length; i++) {
    if (recentTs[i] - recentTs[i-1] < 1500) burstCount++;
  }
  const burstSwitchCount = Math.min(burstCount / 5, 1.0);

  // 4. idleDuration
  let idleMs = 0;
  state.idleEvents.forEach(e => {
    if (e.start > win) idleMs += (e.end || now) - e.start;
  });
  const idleDuration = Math.min(idleMs / WINDOW_SIZE_MS, 1.0);

  // 5. scrollIrregularity — std dev of scroll speed
  const scrolls = state.scrollEvents.filter(e => e.time > win);
  const scrollIrregularity = scrolls.length > 2
    ? Math.min(stdDev(scrolls.map(e => e.speed)) / 100, 1.0) : 0;

  // 6. scrollJerk — avg jerk (rate of speed change)
  const avgJerk = scrolls.length > 1
    ? Math.min(average(scrolls.map(e => e.jerk || 0)) / 200, 1.0) : 0;
  const scrollJerk = avgJerk;

  // 7. keystrokeVariance
  const keys = state.keystrokeTimings.filter(e => e.time > win);
  const keystrokeVariance = keys.length > 3
    ? Math.min(stdDev(keys.map(e => e.delay)) / 500, 1.0) : 0;

  // 8. mouseVelocity — avg mouse speed (high = frantic)
  const mouse = (state.mouseEvents || []).filter(e => e.time > win);
  const mouseVelocity = mouse.length > 2
    ? Math.min(average(mouse.map(e => e.velocity)) / 2000, 1.0) : 0;

  // 9. domainRevisitFreq
  let distCount = 0;
  DISTRACTING_DOMAINS.forEach(d => {
    distCount += (state.domainVisits[d] || []).filter(t => t > win).length;
  });
  const domainRevisitFreq = Math.min(distCount / 5, 1.0);

  // 10. notifOpenSpeed — fast response = more distracted (reactive)
  const notifSpeeds = (state.notifOpenSpeeds || []).filter(e => e.time > win);
  let notifOpenSpeed = 0;
  if (notifSpeeds.length > 0) {
    const avgSpeed = average(notifSpeeds.map(e => e.speed));
    // Normalize: <2s = very reactive (1.0), >60s = not reactive (0.0)
    notifOpenSpeed = Math.max(0, Math.min(1, 1 - (avgSpeed - 2000) / 58000));
  }

  // 11. timeOfDayWeight
  const h = new Date().getHours();
  const timeOfDayWeight = (h >= 14 && h <= 16) ? 0.6 : (h >= 22 || h <= 2) ? 0.8 : 0.3;

  return {
    tabSwitchFreq, tabSwitchSpeed, burstSwitchCount,
    idleDuration,
    scrollIrregularity, scrollJerk,
    keystrokeVariance,
    mouseVelocity,
    domainRevisitFreq,
    notifOpenSpeed,
    timeOfDayWeight
  };
}

// ── DLS SCORING ───────────────────────────────────────────────
async function computeDLS(features) {
  const featureArray = [
    features.tabSwitchFreq, features.idleDuration,
    features.scrollIrregularity, features.keystrokeVariance,
    features.domainRevisitFreq, features.timeOfDayWeight
  ];

  // Try ONNX first (6-feature model — legacy until retrained with 11 features)
  if (ortSession) {
    try {
      const tensor = new ort.Tensor('float32', new Float32Array(featureArray), [1, 6]);
      const results = await ortSession.run({ float_input: tensor });
      const probabilities = results.probabilities.data;
      return Math.min(Math.max(probabilities[1], 0), 1);
    } catch (e) {
      console.warn('[ONNX] Inference failed, using fallback:', e);
    }
  }

  // Weighted sum fallback — uses all 11 features
  const { modelWeights: w } = await chrome.storage.local.get("modelWeights");
  const weights = { ...DEFAULT_WEIGHTS, ...(w || {}) };
  const dls =
    features.tabSwitchFreq    * weights.tabSwitchFreq +
    features.idleDuration     * weights.idleDuration +
    features.scrollIrregularity * weights.scrollIrregularity +
    features.keystrokeVariance * weights.keystrokeVariance +
    features.domainRevisitFreq * weights.domainRevisitFreq +
    features.timeOfDayWeight  * weights.timeOfDayWeight +
    features.tabSwitchSpeed   * weights.tabSwitchSpeed +
    features.notifOpenSpeed   * weights.notifOpenSpeed +
    features.mouseVelocity    * weights.mouseVelocity +
    features.scrollJerk       * weights.scrollJerk +
    features.burstSwitchCount * weights.burstSwitchCount;
  return Math.min(Math.max(dls, 0), 1);
}

// ── INTERVENTION ─────────────────────────────────────────────
async function applyIntervention(dls, state) {
  const prev = state.currentTier;
  if (dls >= TIER3) {
    state.currentTier = 3;
    if (prev < 3) {
      state.interventionCount++;
      const nId = "tier3_" + Date.now();
      state.notifCreateTimes = state.notifCreateTimes || {};
      state.notifCreateTimes[nId] = Date.now();
      chrome.notifications.create(nId, {
        type: "basic", iconUrl: "icons/icon48.png",
        title: "Full Focus Mode",
        message: "Critical distraction! All distracting sites blocked for 5 min.",
        priority: 2
      });
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url) continue;
        if (isDistracting(extractDomain(tab.url))) {
          chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("intervention/block.html") });
        }
      }
      try { await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["distraction_rules"] }); } catch(e) {}
    }
  } else if (dls >= TIER2) {
    state.currentTier = 2;
    if (prev < 2) {
      state.interventionCount++;
      const nId = "tier2_" + Date.now();
      state.notifCreateTimes = state.notifCreateTimes || {};
      state.notifCreateTimes[nId] = Date.now();
      try {
        await chrome.declarativeNetRequest.updateEnabledRulesets({
          enableRulesetIds: ["research_mode_rules", "distraction_rules"]
        });
      } catch(e) {}
      chrome.notifications.create(nId, {
        type: "basic", iconUrl: "icons/icon48.png",
        title: "Research Mode Activated",
        message: "Only academic sites accessible. Social media blocked.",
        priority: 2
      });
    }
  } else if (dls >= TIER1) {
    state.currentTier = 1;
    if (prev < 1) {
      state.interventionCount++;
      const nId = "tier1_" + Date.now();
      state.notifCreateTimes = state.notifCreateTimes || {};
      state.notifCreateTimes[nId] = Date.now();
      chrome.notifications.create(nId, {
        type: "basic", iconUrl: "icons/icon48.png",
        title: "Focus Alert",
        message: `Distraction score: ${Math.round(dls*100)}%. Refocus!`,
        priority: 1
      });
      if (!state.notifications) state.notifications = [];
      state.notifications.push({
        time: Date.now(), tier: 1,
        dlsBefore: dls, dlsAfter: null, complied: null
      });
    }
    try { await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ["distraction_rules", "research_mode_rules"] }); } catch(e) {}
  } else {
    state.currentTier = 0;
    try { await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ["distraction_rules", "research_mode_rules"] }); } catch(e) {}
  }
}

// ── SCORING CYCLE ─────────────────────────────────────────────
async function runScoringCycle() {
  // GATE: only run if session is active
  const { trackingEnabled } = await chrome.storage.local.get('trackingEnabled');
  if (!trackingEnabled) return;

  const state = await getState();
  const features = extractFeatures(state);
  const dls = await computeDLS(features);

  state.currentDLS = dls;
  state.focusWindowsTotal++;

  if (dls >= TIER1) {
    state.focusWindowsDistracted++;
    if ((state.prevDLS || 0) < TIER1) {
      const streakMin = Math.round((Date.now() - state.focusStreakStart) / 60000);
      if (streakMin > state.longestStreak) state.longestStreak = streakMin;
    }
  } else {
    if ((state.prevDLS || 0) >= TIER1) {
      state.focusStreakStart = Date.now();
    }
    const streakMin = Math.round((Date.now() - state.focusStreakStart) / 60000);
    if (streakMin > state.longestStreak) state.longestStreak = streakMin;
  }
  state.prevDLS = dls;

  // Notification compliance check (2 min delay)
  const TWO_MINUTES = 2 * 60 * 1000;
  if (state.notifications) {
    state.notifications.forEach(notif => {
      if (notif.dlsAfter === null && Date.now() - notif.time > TWO_MINUTES) {
        notif.dlsAfter = dls;
        if (notif.complied === null) notif.complied = notif.dlsAfter < notif.dlsBefore - 0.1;
      }
    });
  }

  const completedNotifs = (state.notifications || []).filter(n => n.complied !== null);
  const complianceRate = completedNotifs.length > 0
    ? Math.round((completedNotifs.filter(n => n.complied).length / completedNotifs.length) * 100)
    : null;

  await applyIntervention(dls, state);
  await saveState(state);

  const sessionDuration = getActiveMinutes(state);
  const totalElapsed = Math.round((Date.now() - state.startTime) / 60000);
  const distractionPct = state.focusWindowsTotal > 0
    ? Math.round((state.focusWindowsDistracted / state.focusWindowsTotal) * 100) : 0;
  const focusScore = Math.max(0, Math.round(100 - distractionPct * 0.7 - state.interventionCount * 2));
  const patienceIndex = state.focusWindowsTotal > 0
    ? Math.round(((state.focusWindowsTotal - state.focusWindowsDistracted) / state.focusWindowsTotal) * 100) : 100;

  // Compute avg notif open speed for display
  const recentNotifSpeeds = (state.notifOpenSpeeds || []).filter(e => e.time > Date.now() - 10*60000);
  const avgNotifOpenSpeed = recentNotifSpeeds.length > 0
    ? Math.round(average(recentNotifSpeeds.map(e => e.speed)) / 1000 * 10) / 10
    : null;

  // Compute avg tab switch speed for display
  const recentTs = (state.tabSwitchTimestamps || []).filter(t => t > Date.now() - 5*60000);
  let avgTabSwitchSpeed = null;
  if (recentTs.length >= 2) {
    const intervals = [];
    for (let i = 1; i < recentTs.length; i++) intervals.push(recentTs[i] - recentTs[i-1]);
    avgTabSwitchSpeed = Math.round(average(intervals) / 100) / 10; // seconds, 1dp
  }

  const liveData = {
    currentDLS: dls, currentTier: state.currentTier,
    focusScore, patienceIndex, distractionPercentage: distractionPct,
    longestStreak: state.longestStreak, interventionCount: state.interventionCount,
    sessionDuration, totalElapsed,
    activeTimeMs: state.activeTimeMs || 0,
    complianceRate,
    avgNotifOpenSpeed,
    avgTabSwitchSpeed,
    features, lastUpdated: Date.now()
  };
  await chrome.storage.local.set({ liveData });

  // Session history
  const { sessionHistory = [] } = await chrome.storage.local.get("sessionHistory");
  const entry = {
    sessionId: state.startTime,
    date: new Date().toLocaleDateString(),
    focusScore, sessionDuration, distractionPct,
    patienceIndex, longestStreak: state.longestStreak,
    interventionCount: state.interventionCount, complianceRate
  };
  const idx = sessionHistory.findIndex(s => s.sessionId === state.startTime);
  if (idx >= 0) sessionHistory[idx] = entry; else sessionHistory.push(entry);
  await chrome.storage.local.set({ sessionHistory: sessionHistory.slice(-30) });
}

// ── RECALIBRATION ─────────────────────────────────────────────
async function runRecalibration() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/model/weights`);
    if (res.ok) {
      const { weights } = await res.json();
      if (weights) { await chrome.storage.local.set({ modelWeights: weights }); return; }
    }
  } catch (e) {}

  const { sessionHistory = [] } = await chrome.storage.local.get("sessionHistory");
  if (sessionHistory.length < 3) return;

  const { modelWeights: w } = await chrome.storage.local.get("modelWeights");
  const weights = { ...DEFAULT_WEIGHTS, ...(w || {}) };

  const recent = sessionHistory.slice(-5);
  const avgFocusScore = recent.reduce((a, b) => a + (b.focusScore || 0), 0) / recent.length;
  const complianceSessions = recent.filter(s => s.complianceRate != null);
  const avgCompliance = complianceSessions.length > 0
    ? complianceSessions.reduce((a, b) => a + (b.complianceRate || 0), 0) / complianceSessions.length
    : 50;
  const avgInterventions = recent.reduce((a, b) => a + (b.interventionCount || 0), 0) / recent.length;

  if (avgFocusScore > 75 && avgInterventions > 4) {
    weights.scrollIrregularity = Math.max(weights.scrollIrregularity - 0.02, 0.05);
    weights.keystrokeVariance  = Math.max(weights.keystrokeVariance - 0.02, 0.05);
  }
  if (avgCompliance > 70 && avgFocusScore < 50) {
    weights.domainRevisitFreq = Math.min(weights.domainRevisitFreq + 0.03, 0.35);
    weights.tabSwitchFreq     = Math.min(weights.tabSwitchFreq + 0.02, 0.35);
  }

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  Object.keys(weights).forEach(k => weights[k] = Math.round((weights[k] / total) * 1000) / 1000);

  await chrome.storage.local.set({ modelWeights: weights });
  console.log('[RFRE] Recalibration complete:', weights);
}
