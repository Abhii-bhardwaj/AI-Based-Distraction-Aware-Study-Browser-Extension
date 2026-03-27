// content.js — runs on every page
// Captures: keystrokes, scroll, mouse speed, tab switch speed
// ALL signals gated behind trackingEnabled flag — zero data collected until user starts session

let keystrokeBuffer = [];
let scrollBuffer = [];
let mouseBuffer = [];
let lastKeyTime = null;
let lastScrollY = window.scrollY;
let lastScrollTime = Date.now();
let lastScrollSpeed = 0;
let lastMouseX = null,
  lastMouseY = null,
  lastMouseTime = null;

// ── TRACKING GATE ─────────────────────────────────────────────
let _trackingEnabled = false;
chrome.storage.local.get("trackingEnabled", ({ trackingEnabled }) => {
  _trackingEnabled = !!trackingEnabled;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.trackingEnabled !== undefined) {
    _trackingEnabled = !!changes.trackingEnabled.newValue;
  }
});

// ── KEYSTROKE TIMING ─────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (!_trackingEnabled) return;
  const now = Date.now();
  if (lastKeyTime !== null) {
    const delay = now - lastKeyTime;
    if (delay > 50 && delay < 3000) {
      keystrokeBuffer.push({ delay, time: now });
    }
  }
  lastKeyTime = now;
});

// ── SCROLL SPEED + JERK ──────────────────────────────────────
document.addEventListener(
  "scroll",
  () => {
    if (!_trackingEnabled) return;
    const now = Date.now();
    const delta = Math.abs(window.scrollY - lastScrollY);
    const dt = now - lastScrollTime;
    if (dt > 0) {
      const speed = (delta / dt) * 1000;
      const jerk = Math.abs(speed - lastScrollSpeed);
      scrollBuffer.push({ speed, jerk, time: now });
      lastScrollSpeed = speed;
    }
    lastScrollY = window.scrollY;
    lastScrollTime = now;
  },
  { passive: true },
);

// ── MOUSE VELOCITY (throttled 200ms) ─────────────────────────
let lastMouseFlush = 0;
document.addEventListener(
  "mousemove",
  (e) => {
    if (!_trackingEnabled) return;
    const now = Date.now();
    if (now - lastMouseFlush < 200) return;
    lastMouseFlush = now;
    if (lastMouseX !== null && lastMouseY !== null && lastMouseTime !== null) {
      const dx = e.clientX - lastMouseX;
      const dy = e.clientY - lastMouseY;
      const dt = now - lastMouseTime;
      if (dt > 0) {
        const velocity = (Math.sqrt(dx * dx + dy * dy) / dt) * 1000;
        mouseBuffer.push({ velocity, time: now });
      }
    }
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    lastMouseTime = now;
  },
  { passive: true },
);

// ── FLUSH every 5s ───────────────────────────────────────────
function flushBuffers() {
  const keys = keystrokeBuffer.splice(0);
  const scrolls = scrollBuffer.splice(0);
  const mouse = mouseBuffer.splice(0);
  if (keys.length > 0)
    chrome.runtime
      .sendMessage({ type: "KEYSTROKES", data: keys })
      .catch(() => {});
  if (scrolls.length > 0)
    chrome.runtime
      .sendMessage({ type: "SCROLL", data: scrolls })
      .catch(() => {});
  if (mouse.length > 0)
    chrome.runtime.sendMessage({ type: "MOUSE", data: mouse }).catch(() => {});
}

setInterval(flushBuffers, 5000);

// ═══════════════════════════════════════════════════════════════
// FLOATING WIDGET — draggable DLS orb injected into every page
// Only shown when trackingEnabled = true
// ═══════════════════════════════════════════════════════════════

let widgetRoot = null;

function injectFloatingWidget() {
  if (widgetRoot) return; // already injected

  // Shadow DOM so page styles can't bleed in
  const host = document.createElement("div");
  host.id = "__studyguard_widget__";
  host.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;top:0;left:0;width:0;height:0;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500&display=swap');

      :host {
        --bg-orb: #0d0f14;
        --bg-card: #13161e;
        --border: #232736;
        --border-hover: #2e3347;
        --text-orb: #ffffff;
        --text-card: #e8eaf0;
        --text-muted: #5a6080;
        --text-dark: #3a4060;
        --bg-header: #0d0f14;
        --border-header: #1e2130;
      }
      
      :host([data-theme="light"]) {
        --bg-orb: #ffffff;
        --bg-card: #ffffff;
        --border: #e2e5ef;
        --border-hover: #cdd1e0;
        --text-orb: #0d0f14;
        --text-card: #0d0f14;
        --text-muted: #6b7280;
        --text-dark: #9ca3af;
        --bg-header: #f4f6fb;
        --border-header: #e2e5ef;
      }

      * { margin:0; padding:0; box-sizing:border-box; }

      #widget {
        position: fixed;
        bottom: 80px;
        right: 20px;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        cursor: grab;
        user-select: none;
        pointer-events: all;
        transition: width 0.25s cubic-bezier(.4,0,.2,1),
                    height 0.25s cubic-bezier(.4,0,.2,1),
                    border-radius 0.25s cubic-bezier(.4,0,.2,1),
                    box-shadow 0.2s;
        will-change: transform;
        z-index: 2147483647;
      }

      #widget.grabbing { cursor: grabbing; }

      /* Collapsed — orb */
      #widget .orb {
        width: 56px; height: 56px;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        position: relative;
        transition: transform 0.15s;
      }
      #widget .orb:hover { transform: scale(1.08); }

      .orb-ring {
        position: absolute; inset: 0; border-radius: 50%;
        border: 2px solid currentColor;
        opacity: 0.35;
        animation: spin 8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      .orb-fill {
        position: absolute; inset: 4px; border-radius: 50%;
        transition: background 0.5s;
      }

      /* Three.js orb canvas — replaces orb-fill when loaded */
      .orb-canvas {
        position: absolute; inset: 0;
        border-radius: 50%;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.4s;
      }
      .orb-canvas.ready { opacity: 1; }
      /* hide the CSS fill when canvas is ready */
      .orb-canvas.ready ~ .orb-fill,
      .orb-fill.hidden { opacity: 0; }

      .orb-score {
        position: relative; z-index: 1;
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px; font-weight: 500;
        color: #fff;
        text-shadow: 0 1px 3px rgba(0,0,0,0.5);
        line-height: 1;
      }

      /* Tier dot */
      .tier-dot {
        position: absolute; bottom: 2px; right: 2px;
        width: 10px; height: 10px; border-radius: 50%;
        border: 2px solid var(--bg-orb);
        transition: background 0.4s;
      }

      /* Expanded card */
      #widget .card {
        display: none;
        width: 220px;
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      }

      #widget.expanded .orb { display: none; }
      #widget.expanded .card { display: block; }
      #widget.expanded {
        width: 220px; height: auto;
        border-radius: 14px;
        background: transparent;
      }

      .card-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px 8px;
        border-bottom: 1px solid var(--border-header);
        background: var(--bg-header);
      }
      .card-title {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px; font-weight: 500;
        color: var(--text-muted); letter-spacing: .08em; text-transform: uppercase;
      }
      .card-close {
        width: 18px; height: 18px; border-radius: 50%;
        background: var(--border-header); border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: var(--text-muted); font-size: 10px; line-height: 1;
        transition: background 0.15s, color 0.15s;
        pointer-events: all;
      }
      .card-close:hover { background: var(--border-hover); color: var(--text-card); }

      .card-score-row {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 12px 8px;
      }
      .card-score-num {
        font-family: 'JetBrains Mono', monospace;
        font-size: 36px; font-weight: 500; line-height: 1;
        transition: color 0.4s;
      }
      .card-score-pct { font-size: 14px; color: var(--text-muted); }
      .card-tier-chip {
        margin-left: auto;
        font-size: 10px; font-weight: 500;
        padding: 3px 7px; border-radius: 12px;
      }

      .card-bar-track {
        margin: 0 12px 10px;
        height: 3px; background: var(--border-header); border-radius: 2px; overflow: hidden;
      }
      .card-bar-fill { height: 3px; border-radius: 2px; transition: width 0.5s, background 0.4s; }

      .card-stats {
        display: grid; grid-template-columns: 1fr 1fr;
        gap: 1px; background: var(--border-header);
        border-top: 1px solid var(--border-header);
        border-bottom: 1px solid var(--border-header);
      }
      .card-stat {
        background: var(--bg-card); padding: 8px 12px;
      }
      .card-stat-val {
        font-family: 'JetBrains Mono', monospace;
        font-size: 14px; font-weight: 500; color: var(--text-card);
      }
      .card-stat-lbl { font-size: 9px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; margin-top: 1px; }

      .card-signals { padding: 8px 12px 10px; }
      .card-sig-row {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 5px;
      }
      .card-sig-row:last-child { margin-bottom: 0; }
      .card-sig-name { font-size: 9px; color: var(--text-muted); flex: 1; }
      .card-sig-track { width: 48px; height: 2px; background: var(--border-header); border-radius: 1px; }
      .card-sig-fill { height: 2px; border-radius: 1px; transition: width 0.4s; }
      .card-sig-val { font-family: 'JetBrains Mono', monospace; font-size: 9px; color: var(--text-muted); width: 22px; text-align: right; }

      .card-footer {
        padding: 7px 12px;
        background: var(--bg-header); border-top: 1px solid var(--border-header);
        display: flex; align-items: center; justify-content: space-between;
      }
      .card-footer-lbl { font-size: 9px; color: var(--text-dark); }
      .end-btn {
        font-size: 9px; font-weight: 500;
        padding: 3px 8px; border-radius: 6px;
        border: 1px solid var(--border-hover); background: transparent;
        color: var(--text-muted); cursor: pointer; transition: all 0.15s;
        pointer-events: all;
      }
      .end-btn:hover { border-color: #ff4560; color: #ff4560; background: #ff456010; }

      .open-panel-btn {
        font-size: 9px; font-weight: 500;
        padding: 3px 8px; border-radius: 6px;
        border: 1px solid var(--border-hover);
        background: transparent;
        color: var(--text-muted);
        cursor: pointer; transition: all 0.15s;
        pointer-events: all;
      }
      .open-panel-btn:hover {
        border-color: #7b6fff;
        color: #7b6fff;
        background: rgba(123,111,255,0.08);
      }

      /* Tier colors */
      .c0 { color: #00e5a0; }
      .c1 { color: #ffb830; }
      .c2 { color: #ff7c40; }
      .c3 { color: #ff4560; }
      .bg0 { background: #00e5a020; border: 1px solid #00e5a030; color: #00e5a0; }
      .bg1 { background: #ffb83020; border: 1px solid #ffb83030; color: #ffb830; }
      .bg2 { background: #ff7c4020; border: 1px solid #ff7c4030; color: #ff7c40; }
      .bg3 { background: #ff456020; border: 1px solid #ff456030; color: #ff4560; }

      /* Pulse ring on tier 3 */
      @keyframes danger-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(255,69,96,0.4); }
        50% { box-shadow: 0 0 0 8px rgba(255,69,96,0); }
      }
      .tier3-pulse { animation: danger-pulse 1.5s infinite; }
    </style>

    <div id="widget">
      <!-- Collapsed orb -->
      <div class="orb" id="orb-btn">
        <canvas class="orb-canvas" id="orb-canvas" width="56" height="56"></canvas>
        <div class="orb-ring c0" id="orb-ring"></div>
        <div class="orb-fill" id="orb-fill" style="background:#00e5a020"></div>
        <span class="orb-score" id="orb-score">0%</span>
        <div class="tier-dot" id="tier-dot" style="background:#00e5a0"></div>
      </div>

      <!-- Expanded card -->
      <div class="card" id="card">
        <div class="card-header">
          <span class="card-title">StudyGuard</span>
          <button class="card-close" id="card-close">✕</button>
        </div>

        <div class="card-score-row">
          <span class="card-score-num c0" id="card-score">0</span>
          <span class="card-score-pct">%</span>
          <span class="card-tier-chip bg0" id="card-tier">Focused</span>
        </div>

        <div class="card-bar-track">
          <div class="card-bar-fill" id="card-bar" style="width:0%;background:#00e5a0"></div>
        </div>

        <div class="card-stats">
          <div class="card-stat">
            <div class="card-stat-val" id="cs-focus">—</div>
            <div class="card-stat-lbl">Focus score</div>
          </div>
          <div class="card-stat">
            <div class="card-stat-val" id="cs-streak">—</div>
            <div class="card-stat-lbl">Streak</div>
          </div>
          <div class="card-stat">
            <div class="card-stat-val" id="cs-interv">—</div>
            <div class="card-stat-lbl">Interventions</div>
          </div>
          <div class="card-stat">
            <div class="card-stat-val" id="cs-session">—</div>
            <div class="card-stat-lbl">Session</div>
          </div>
        </div>

        <div class="card-signals" id="card-signals"></div>

        <div class="card-footer">
          <span class="card-footer-lbl" id="cf-time">0 min active</span>
          <button class="open-panel-btn" id="widget-open-panel">Open panel</button>
          <button class="end-btn" id="widget-end-btn">End session</button>
        </div>
      </div>
    </div>
  `;

  widgetRoot = shadow;

  const widget = shadow.getElementById("widget");
  const orbBtn = shadow.getElementById("orb-btn");
  const cardClose = shadow.getElementById("card-close");
  const endBtn = shadow.getElementById("widget-end-btn");
  const openPanelBtn = shadow.getElementById("widget-open-panel");

  // ── DRAG ──────────────────────────────────────────────────
  let isDragging = false,
    dragStartX,
    dragStartY,
    startRight,
    startBottom;
  // Store position as right/bottom from viewport edge
  let posRight = 20,
    posBottom = 80;

  function setPos(r, b) {
    posRight = Math.max(4, Math.min(window.innerWidth - 60, r));
    posBottom = Math.max(4, Math.min(window.innerHeight - 60, b));
    widget.style.right = posRight + "px";
    widget.style.bottom = posBottom + "px";
  }
  setPos(posRight, posBottom);

  widget.addEventListener("mousedown", (e) => {
    if (
      e.target === cardClose ||
      e.target === endBtn ||
      e.target === openPanelBtn
    )
      return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startRight = posRight;
    startBottom = posBottom;
    widget.classList.add("grabbing");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    // right decreases as mouse moves right (mirror X)
    // bottom decreases as mouse moves down (mirror Y) — subtract dy
    setPos(startRight - dx, startBottom - dy);
  });

  document.addEventListener("mouseup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    widget.classList.remove("grabbing");
    // Save position
    chrome.storage.local.set({
      widgetPos: { right: posRight, bottom: posBottom },
    });
  });

  // Touch drag support
  widget.addEventListener(
    "touchstart",
    (e) => {
      if (
        e.target === cardClose ||
        e.target === endBtn ||
        e.target === openPanelBtn
      )
        return;
      const t = e.touches[0];
      isDragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      startRight = posRight;
      startBottom = posBottom;
      e.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!isDragging) return;
      const t = e.touches[0];
      setPos(
        startRight - (t.clientX - dragStartX),
        startBottom - (t.clientY - dragStartY),
      );
    },
    { passive: true },
  );

  document.addEventListener("touchend", () => {
    isDragging = false;
    chrome.storage.local.set({
      widgetPos: { right: posRight, bottom: posBottom },
    });
  });

  // Restore saved position
  chrome.storage.local.get("widgetPos", ({ widgetPos }) => {
    if (widgetPos) setPos(widgetPos.right, widgetPos.bottom);
  });

  // ── EXPAND / COLLAPSE ────────────────────────────────────
  let expanded = false;

  orbBtn.addEventListener("click", (e) => {
    if (isDragging) return;
    expanded = true;
    widget.classList.add("expanded");
  });

  cardClose.addEventListener("click", (e) => {
    e.stopPropagation();
    expanded = false;
    widget.classList.remove("expanded");
  });

  // ── END SESSION ──────────────────────────────────────────
  endBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.storage.local.set({ trackingEnabled: false }, () => {
      removeWidget();
    });
  });

  // ── OPEN PANEL ───────────────────────────────────────────
  openPanelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "OPEN_PANEL" });
  });

  // ── UPDATE UI ─────────────────────────────────────────────
  const TIER_COLORS = ["#00e5a0", "#ffb830", "#ff7c40", "#ff4560"];
  const TIER_FILLS = ["#00e5a020", "#ffb83020", "#ff7c4020", "#ff456020"];
  const TIER_CLS = ["c0 bg0", "c1 bg1", "c2 bg2", "c3 bg3"];
  const TIER_LABELS = ["Focused", "Warning", "Research mode", "Blocked"];
  const TOP_SIGNALS = [
    "tabSwitchFreq",
    "tabSwitchSpeed",
    "domainRevisitFreq",
    "mouseVelocity",
    "keystrokeVariance",
  ];
  const SIG_NAMES = {
    tabSwitchFreq: "Tab switches",
    tabSwitchSpeed: "Switch speed",
    domainRevisitFreq: "Distr. sites",
    mouseVelocity: "Mouse speed",
    keystrokeVariance: "Keystrokes",
  };

  function sigColor(v) {
    return v < 0.35 ? "#00e5a0" : v < 0.65 ? "#ffb830" : "#ff4560";
  }

  function updateWidget(data) {
    if (!data) return;
    const dls = data.currentDLS || 0;
    const pct = Math.round(dls * 100);
    const tier = data.currentTier || 0;
    const color = TIER_COLORS[tier];
    const fill = TIER_FILLS[tier];
    const cls = TIER_CLS[tier];
    const label = TIER_LABELS[tier];

    // Orb
    shadow.getElementById("orb-score").textContent = pct + "%";
    shadow.getElementById("orb-fill").style.background = fill;
    shadow.getElementById("orb-ring").style.color = color;
    shadow.getElementById("tier-dot").style.background = color;
    if (tier === 3) widget.classList.add("tier3-pulse");
    else widget.classList.remove("tier3-pulse");

    // Drive Three.js orb if loaded
    if (_orbScene) _orbScene.setDLS(dls, tier);

    // Card score
    const csEl = shadow.getElementById("card-score");
    csEl.textContent = pct;
    csEl.className = "card-score-num " + cls.split(" ")[0];
    const ctEl = shadow.getElementById("card-tier");
    ctEl.textContent = label;
    ctEl.className = "card-tier-chip " + cls.split(" ")[1];
    shadow.getElementById("card-bar").style.width = pct + "%";
    shadow.getElementById("card-bar").style.background = color;

    // Stats
    shadow.getElementById("cs-focus").textContent = data.focusScore ?? "—";
    shadow.getElementById("cs-streak").textContent =
      data.longestStreak != null ? data.longestStreak + "m" : "—";
    shadow.getElementById("cs-interv").textContent =
      data.interventionCount ?? "—";
    shadow.getElementById("cs-session").textContent =
      data.sessionDuration != null ? data.sessionDuration + "m" : "—";
    shadow.getElementById("cf-time").textContent =
      (data.sessionDuration ?? 0) + " min active";

    // Signals
    if (data.features) {
      shadow.getElementById("card-signals").innerHTML = TOP_SIGNALS.map(
        (key) => {
          const val = data.features[key] ?? 0;
          const p = Math.round(val * 100);
          const c = sigColor(val);
          return `<div class="card-sig-row">
          <span class="card-sig-name">${SIG_NAMES[key]}</span>
          <div class="card-sig-track"><div class="card-sig-fill" style="width:${p}%;background:${c}"></div></div>
          <span class="card-sig-val" style="color:${c}">${p}%</span>
        </div>`;
        },
      ).join("");
    }
  }

  // ── POLL storage every 3s ─────────────────────────────────
  function pollWidget() {
    chrome.storage.local.get(
      ["liveData", "trackingEnabled"],
      ({ liveData, trackingEnabled }) => {
        if (!trackingEnabled) {
          removeWidget();
          return;
        }
        updateWidget(liveData);
      },
    );
  }

  // ── THREE.JS ORB ──────────────────────────────────────────
  // Three.js is loaded dynamically from web_accessible_resources.
  // It attaches to the page's window object, which content scripts share.
  let _orbScene = null;

  function initOrbScene() {
    if (!window.THREE) return;
    if (_orbScene) return;

    const canvas = shadow.getElementById("orb-canvas");
    if (!canvas) return;

    const SIZE = 56;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(SIZE, SIZE);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.z = 2.8;

    // Sphere geometry — smooth icosphere-like
    const geometry = new THREE.SphereGeometry(1, 32, 32);

    // Main sphere material — MeshPhongMaterial for specular highlight
    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color(0x00e5a0),
      emissive: new THREE.Color(0x003322),
      shininess: 80,
      transparent: true,
      opacity: 0.92,
    });

    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    // Outer glow shell — slightly larger, additive-like
    const glowGeo = new THREE.SphereGeometry(1.18, 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x00e5a0),
      transparent: true,
      opacity: 0.08,
      side: THREE.BackSide,
    });
    const glowMesh = new THREE.Mesh(glowGeo, glowMat);
    scene.add(glowMesh);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
    scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0xffffff, 1.4, 10);
    pointLight.position.set(2, 2, 3);
    scene.add(pointLight);

    const rimLight = new THREE.PointLight(0x4488ff, 0.5, 8);
    rimLight.position.set(-2, -1, -2);
    scene.add(rimLight);

    // Tier color palette — matches the widget's existing color scheme
    const TIER_COLORS_THREE = [
      { sphere: 0x00e5a0, emissive: 0x003322, glow: 0x00e5a0 }, // tier 0 green
      { sphere: 0xffb830, emissive: 0x332200, glow: 0xffb830 }, // tier 1 amber
      { sphere: 0xff7c40, emissive: 0x331100, glow: 0xff7c40 }, // tier 2 orange
      { sphere: 0xff4560, emissive: 0x330010, glow: 0xff4560 }, // tier 3 red
    ];

    let currentDLS = 0;
    let targetDLS = 0;
    let currentTier = 0;
    let animId = null;
    let elapsed = 0;

    function tick() {
      elapsed += 0.016; // ~60fps

      // Ease DLS
      currentDLS += (targetDLS - currentDLS) * 0.04;

      // Rotate sphere — faster when more distracted
      const rotSpeed = 0.004 + currentDLS * 0.018;
      sphere.rotation.y += rotSpeed;
      sphere.rotation.x += rotSpeed * 0.4;

      // Breathe / pulse scale
      const chaos = currentDLS;
      const breatheFreq = 1.0 + chaos * 3.0; // faster pulse under distraction
      const breatheAmp = 0.03 + chaos * 0.06;
      const scale = 1.0 + Math.sin(elapsed * breatheFreq) * breatheAmp;
      sphere.scale.setScalar(scale);
      glowMesh.scale.setScalar(scale * (1.0 + chaos * 0.12));

      // Glow opacity intensifies with distraction
      glowMat.opacity = 0.06 + chaos * 0.22;

      // Colour — interpolate between tier colours
      const tierF = Math.min(currentDLS * 3, 2.999);
      const tIdx = Math.floor(tierF);
      const tFrac = tierF - tIdx;
      const cA = TIER_COLORS_THREE[tIdx];
      const cB = TIER_COLORS_THREE[tIdx + 1];
      const sphereCol = new THREE.Color(cA.sphere).lerp(
        new THREE.Color(cB.sphere),
        tFrac,
      );
      const emissiveCol = new THREE.Color(cA.emissive).lerp(
        new THREE.Color(cB.emissive),
        tFrac,
      );
      const glowCol = new THREE.Color(cA.glow).lerp(
        new THREE.Color(cB.glow),
        tFrac,
      );

      material.color.copy(sphereCol);
      material.emissive.copy(emissiveCol);
      glowMat.color.copy(glowCol);

      // Point light colour matches sphere
      pointLight.color.copy(sphereCol);
      pointLight.intensity = 1.2 + chaos * 0.8;

      renderer.render(scene, camera);
      animId = requestAnimationFrame(tick);
    }

    // Fade in the canvas, hide the CSS fill
    canvas.classList.add("ready");
    const orbFill = shadow.getElementById("orb-fill");
    if (orbFill) orbFill.classList.add("hidden");

    tick();

    _orbScene = {
      setDLS(dls, tier) {
        targetDLS = Math.max(0, Math.min(1, dls));
        currentTier = tier || 0;
      },
      destroy() {
        if (animId) cancelAnimationFrame(animId);
        renderer.dispose();
        geometry.dispose();
        glowGeo.dispose();
        material.dispose();
        glowMat.dispose();
        _orbScene = null;
      },
    };
  }

  // Load Three.js from web_accessible_resources, then init orb
  // Only inject once per page — check if already on window
  function loadThreeAndInitOrb() {
    if (window.THREE) {
      initOrbScene();
      return;
    }
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("libs/three.min.js");
    script.onload = () => {
      initOrbScene();
    };
    script.onerror = () => {
      /* silently skip — CSS orb still shows */
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // Small delay so the shadow DOM has painted before we grab the canvas
  setTimeout(loadThreeAndInitOrb, 100);

  let widgetPoll = setInterval(pollWidget, 3000);
  pollWidget(); // immediate first render

  // Set initial theme
  chrome.storage.local.get("userTheme", ({ userTheme }) => {
    if (userTheme === "light") host.setAttribute("data-theme", "light");
    else host.removeAttribute("data-theme");
  });

  widgetRoot._stopPoll = () => {
    clearInterval(widgetPoll);
    if (_orbScene) _orbScene.destroy();
  };
}

function removeWidget() {
  if (widgetRoot?._stopPoll) widgetRoot._stopPoll();
  const host = document.getElementById("__studyguard_widget__");
  if (host) host.remove();
  widgetRoot = null;
}

// ── REACT TO STORAGE CHANGES ─────────────────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.trackingEnabled) {
    if (changes.trackingEnabled.newValue === true) {
      injectFloatingWidget();
    } else {
      removeWidget();
    }
  }
  if (changes.userTheme) {
    const host = document.getElementById("__studyguard_widget__");
    if (host) {
      if (changes.userTheme.newValue === "light")
        host.setAttribute("data-theme", "light");
      else host.removeAttribute("data-theme");
    }
  }
});

// ── ON PAGE LOAD: inject if session already active ────────────
chrome.storage.local.get("trackingEnabled", ({ trackingEnabled }) => {
  if (trackingEnabled) injectFloatingWidget();
});
