# 🧠 Distraction-Aware Study Browser Extension

**Team:** Abhishek Bhardwaj | Aman Saxena | Abhijeet Singh  
**Institution:** Lovely Professional University | 2026

---

## 📁 Project Structure

```
distraction-extension/
├── extension/               ← Chrome Extension (load this in Chrome)
│   ├── manifest.json        ← Extension config
│   ├── background.js        ← MBSAM + DLPM + ATIE + RFRE
│   ├── content.js           ← Keystroke + scroll signal capture
│   ├── popup/
│   │   └── popup.html       ← Analytics dashboard (Chart.js)
│   ├── intervention/
│   │   └── block.html       ← Tier 3 block page with timer
│   ├── rules/
│   │   └── distraction_rules.json  ← Site blocking rules
│   └── models/
│       └── distraction_model.onnx  ← (Add after training ML model)
│
└── ml-training/             ← Python ML (run locally)
    └── train_model.py       ← XGBoost training + ONNX export
```

---

## 🚀 How to Run the Extension

### Step 1 — Open Chrome Extension Manager
1. Open **Google Chrome**
2. Go to `chrome://extensions/`
3. Enable **Developer Mode** (top right toggle)

### Step 2 — Load the Extension
1. Click **"Load unpacked"**
2. Select the `extension/` folder
3. Extension icon will appear in your browser toolbar 🎉

### Step 3 — Test It
- Click the extension icon → Dashboard opens
- Browse YouTube/Instagram → distraction score will rise
- At DLS ≥ 0.50: You'll get a warning notification
- At DLS ≥ 0.65: Research mode activates
- At DLS ≥ 0.78: Block page appears with 5-min cooldown

---

## 🤖 ML Model Training (Optional — Improves Accuracy)

The extension works out-of-the-box with a weighted scoring fallback.  
To train and deploy the actual ML model:

```bash
cd ml-training

# Install dependencies
pip install xgboost scikit-learn numpy pandas skl2onnx onnx

# Train the model
python train_model.py

# Copy the ONNX model to extension
cp distraction_model.onnx ../extension/models/
```

After copying the ONNX model, the extension will automatically use it  
for inference (via ONNX.js — integration coming in Week 2).

---

## 👥 Team Responsibilities

| Module | Who | Files |
|--------|-----|-------|
| ML Training + ONNX Export | **Abhishek** | `ml-training/train_model.py` |
| Feature Extraction (FETNE) | **Abhishek** | `background.js` → extractFeatures() |
| Signal Acquisition (MBSAM) | **Aman** | `background.js` → Tab/Idle listeners |
| Intervention Engine (ATIE) | **Aman** | `background.js` → applyIntervention() |
| Content Script | **Aman** | `content.js` |
| Analytics Dashboard (BAE) | **Abhijeet** | `popup/popup.html` |
| Block Page UI | **Abhijeet** | `intervention/block.html` |
| Feedback Loop (RFRE) | **Abhishek** | `background.js` → recalibrateModel() |

---

## 🔧 Chrome Permissions Used

| Permission | Why |
|------------|-----|
| `tabs` | Detect tab switches, get active URL |
| `storage` | Save session data locally |
| `notifications` | Send Tier 1 focus alerts |
| `idle` | Detect when user is inactive |
| `declarativeNetRequest` | Block distracting sites (Tier 2/3) |
| `scripting` | Run content.js on pages |

---

## 📊 DLS Score Thresholds

| DLS Range | Tier | Action |
|-----------|------|--------|
| 0.00 – 0.49 | 0 | No action |
| 0.50 – 0.64 | 1 | Warning notification |
| 0.65 – 0.77 | 2 | Research mode (whitelist only) |
| 0.78 – 1.00 | 3 | Full block + 5 min cooldown |

---

## 🐛 Debugging Tips

- Open `chrome://extensions/` → Click **"Service Worker"** to see background.js logs
- Open extension popup → Right-click → Inspect to debug popup.html
- Check `chrome.storage.local` in DevTools: Application → Storage → Extension Storage
