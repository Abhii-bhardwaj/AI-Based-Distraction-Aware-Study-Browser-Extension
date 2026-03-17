// ============================================================
// server.js — StudyGuard Backend
// Express + SQLite (better-sqlite3)
// Stores: sessions, snapshots, model weights
// Serves: weights to extension, stats to dashboard
// ============================================================

const express = require('express');
const cors    = require('cors');
const Database = require('better-sqlite3');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = 3001;

// ── DATABASE SETUP ────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'studyguard.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  -- One row per study session
  
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER UNIQUE,          -- epoch ms from extension
    start_time  TEXT,
    end_time    TEXT,
    duration_min REAL,
    focus_score  REAL,
    patience_index REAL,
    distraction_pct REAL,
    intervention_count INTEGER,
    longest_streak_min REAL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Live snapshots every 30s (raw feature vectors + DLS)
  CREATE TABLE IF NOT EXISTS snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER,
    timestamp   INTEGER,
    dls         REAL,
    tier        INTEGER,
    focus_score REAL,
    tab_switch_freq    REAL,
    idle_duration      REAL,
    scroll_irregularity REAL,
    keystroke_variance  REAL,
    domain_revisit_freq REAL,
    time_of_day_weight  REAL,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Model weights history (updated by recalibration)
  CREATE TABLE IF NOT EXISTS model_weights (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_switch_freq      REAL DEFAULT 0.30,
    idle_duration        REAL DEFAULT 0.20,
    scroll_irregularity  REAL DEFAULT 0.15,
    keystroke_variance   REAL DEFAULT 0.15,
    domain_revisit_freq  REAL DEFAULT 0.15,
    time_of_day_weight   REAL DEFAULT 0.05,
    updated_at  TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default weights if none exist
const weightCount = db.prepare('SELECT COUNT(*) as c FROM model_weights').get();
if (weightCount.c === 0) {
  db.prepare(`
    INSERT INTO model_weights (tab_switch_freq, idle_duration, scroll_irregularity,
      keystroke_variance, domain_revisit_freq, time_of_day_weight)
    VALUES (0.30, 0.20, 0.15, 0.15, 0.15, 0.05)
  `).run();
  console.log('[DB] Default model weights seeded');
}

console.log('[DB] Database ready at', DB_PATH);

// ── PREPARED STATEMENTS ───────────────────────────────────────
const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (session_id, start_time, duration_min, focus_score,
      patience_index, distraction_pct, intervention_count, longest_streak_min)
    VALUES (@session_id, @start_time, @duration_min, @focus_score,
      @patience_index, @distraction_pct, @intervention_count, @longest_streak_min)
    ON CONFLICT(session_id) DO UPDATE SET
      duration_min = excluded.duration_min,
      focus_score  = excluded.focus_score,
      patience_index = excluded.patience_index,
      distraction_pct = excluded.distraction_pct,
      intervention_count = excluded.intervention_count,
      longest_streak_min = excluded.longest_streak_min
  `),

  completeSession: db.prepare(`
    UPDATE sessions SET end_time = @end_time WHERE session_id = @session_id
  `),

  insertSnapshot: db.prepare(`
    INSERT INTO snapshots (session_id, timestamp, dls, tier, focus_score,
      tab_switch_freq, idle_duration, scroll_irregularity, keystroke_variance,
      domain_revisit_freq, time_of_day_weight)
    VALUES (@session_id, @timestamp, @dls, @tier, @focus_score,
      @tab_switch_freq, @idle_duration, @scroll_irregularity, @keystroke_variance,
      @domain_revisit_freq, @time_of_day_weight)
  `),

  getLatestWeights: db.prepare(`
    SELECT * FROM model_weights ORDER BY id DESC LIMIT 1
  `),

  updateWeights: db.prepare(`
    INSERT INTO model_weights (tab_switch_freq, idle_duration, scroll_irregularity,
      keystroke_variance, domain_revisit_freq, time_of_day_weight, updated_at)
    VALUES (@tab_switch_freq, @idle_duration, @scroll_irregularity,
      @keystroke_variance, @domain_revisit_freq, @time_of_day_weight, datetime('now'))
  `),

  getAllSessions: db.prepare(`
    SELECT * FROM sessions ORDER BY session_id DESC LIMIT 50
  `),

  getSessionSnapshots: db.prepare(`
    SELECT * FROM snapshots WHERE session_id = ? ORDER BY timestamp ASC
  `),

  getStats: db.prepare(`
    SELECT
      COUNT(DISTINCT session_id) as total_sessions,
      COUNT(*) as total_snapshots,
      AVG(focus_score) as avg_focus_score,
      MAX(focus_score) as best_focus_score,
      SUM(duration_min) as total_study_minutes
    FROM sessions WHERE focus_score IS NOT NULL
  `),

  getSnapshotCount: db.prepare(`SELECT COUNT(*) as c FROM snapshots`),
};

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({ origin: '*' })); // Allow extension to call API
app.use(express.json());

// Log all requests
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.path}`);
  next();
});

// ── ROUTES ────────────────────────────────────────────────────

// GET /api/status — health check + db stats
app.get('/api/status', (req, res) => {
  const stats = stmts.getStats.get();
  const snaps = stmts.getSnapshotCount.get();
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    totalSessions: stats?.total_sessions || 0,
    totalSnapshots: snaps?.c || 0,
    avgFocusScore: stats?.avg_focus_score ? Math.round(stats.avg_focus_score) : null,
    totalStudyMinutes: stats?.total_study_minutes ? Math.round(stats.total_study_minutes) : 0,
    dbPath: DB_PATH
  });
});

// POST /api/session/register — new session started
app.post('/api/session/register', (req, res) => {
  const { sessionId, startTime } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    stmts.upsertSession.run({
      session_id: sessionId,
      start_time: startTime || new Date().toISOString(),
      duration_min: 0, focus_score: null, patience_index: null,
      distraction_pct: null, intervention_count: 0, longest_streak_min: 0
    });
    res.json({ ok: true, sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/session/snapshot — live data push from extension (every 30s)
app.post('/api/session/snapshot', (req, res) => {
  const {
    currentDLS, currentTier, focusScore, patienceIndex,
    distractionPercentage, longestStreak, interventionCount,
    sessionDuration, features, timestamp
  } = req.body;

  // Guess session_id from timestamp (extension sends lastUpdated)
  const sessionId = req.body.sessionId || (timestamp - (sessionDuration || 0) * 60000);

  try {
    // Upsert session summary
    stmts.upsertSession.run({
      session_id: sessionId,
      start_time: new Date(sessionId).toISOString(),
      duration_min: sessionDuration || 0,
      focus_score: focusScore,
      patience_index: patienceIndex,
      distraction_pct: distractionPercentage,
      intervention_count: interventionCount || 0,
      longest_streak_min: longestStreak || 0
    });

    // Insert raw snapshot
    stmts.insertSnapshot.run({
      session_id: sessionId,
      timestamp: timestamp || Date.now(),
      dls: currentDLS || 0,
      tier: currentTier || 0,
      focus_score: focusScore || 0,
      tab_switch_freq:     features?.tabSwitchFreq || 0,
      idle_duration:       features?.idleDuration || 0,
      scroll_irregularity: features?.scrollIrregularity || 0,
      keystroke_variance:  features?.keystrokeVariance || 0,
      domain_revisit_freq: features?.domainRevisitFreq || 0,
      time_of_day_weight:  features?.timeOfDayWeight || 0,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[snapshot error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/session/complete — session ended
app.post('/api/session/complete', (req, res) => {
  const { sessionId, endTime } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  stmts.completeSession.run({ session_id: sessionId, end_time: endTime || new Date().toISOString() });
  res.json({ ok: true });
});

// GET /api/sessions — list all sessions
app.get('/api/sessions', (req, res) => {
  const sessions = stmts.getAllSessions.all();
  res.json({ sessions });
});

// GET /api/sessions/:id/snapshots — all snapshots for a session
app.get('/api/sessions/:id/snapshots', (req, res) => {
  const snaps = stmts.getSessionSnapshots.all(req.params.id);
  res.json({ snapshots: snaps });
});

// GET /api/model/weights — get latest weights (extension polls this)
app.get('/api/model/weights', (req, res) => {
  const row = stmts.getLatestWeights.get();
  if (!row) return res.status(404).json({ error: 'No weights found' });
  res.json({
    weights: {
      tabSwitchFreq:      row.tab_switch_freq,
      idleDuration:       row.idle_duration,
      scrollIrregularity: row.scroll_irregularity,
      keystrokeVariance:  row.keystroke_variance,
      domainRevisitFreq:  row.domain_revisit_freq,
      timeOfDayWeight:    row.time_of_day_weight,
    },
    updatedAt: row.updated_at
  });
});

// POST /api/model/weights — update weights (called after ML retraining)
app.post('/api/model/weights', (req, res) => {
  const w = req.body;
  if (!w.tabSwitchFreq) return res.status(400).json({ error: 'weights object required' });

  // Validate: weights must sum to ~1.0
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum < 0.8 || sum > 1.2) {
    return res.status(400).json({ error: `Weights sum to ${sum.toFixed(2)}, must be ~1.0` });
  }

  stmts.updateWeights.run({
    tab_switch_freq:      w.tabSwitchFreq,
    idle_duration:        w.idleDuration,
    scroll_irregularity:  w.scrollIrregularity,
    keystroke_variance:   w.keystrokeVariance,
    domain_revisit_freq:  w.domainRevisitFreq,
    time_of_day_weight:   w.timeOfDayWeight,
  });

  res.json({ ok: true, weights: w });
});

// GET /api/training-data — export feature vectors for ML training
app.get('/api/training-data', (req, res) => {
  const snaps = db.prepare(`
    SELECT
      tab_switch_freq, idle_duration, scroll_irregularity,
      keystroke_variance, domain_revisit_freq, time_of_day_weight,
      dls,
      CASE WHEN dls >= 0.50 THEN 1 ELSE 0 END as label
    FROM snapshots
    ORDER BY id DESC
    LIMIT 5000
  `).all();

  res.json({ count: snaps.length, data: snaps });
});

// ── START ─────────────────────────────────────────────────────

// GET /api/analytics/summary — for dashboard overview (TASK-011)
app.get('/api/analytics/summary', (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY id DESC LIMIT 30').all();
  const avgFocus = sessions.length
    ? (sessions.reduce((a, b) => a + (b.focus_score || 0), 0) / sessions.length).toFixed(1)
    : 0;
  res.json({ sessions, avgFocusScore: parseFloat(avgFocus), totalSessions: sessions.length });
});

app.listen(PORT, () => {
  console.log(`\n🚀 StudyGuard Backend running on http://localhost:${PORT}`);
  console.log(`📦 Database: ${DB_PATH}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  GET  /api/status`);
  console.log(`  POST /api/session/register`);
  console.log(`  POST /api/session/snapshot`);
  console.log(`  POST /api/session/complete`);
  console.log(`  GET  /api/sessions`);
  console.log(`  GET  /api/sessions/:id/snapshots`);
  console.log(`  GET  /api/model/weights`);
  console.log(`  POST /api/model/weights`);
  console.log(`  GET  /api/training-data`);
  console.log(`\n⏳ Waiting for extension to connect...\n`);
});
