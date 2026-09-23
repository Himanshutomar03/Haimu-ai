# HaimuAi v3 — Stealth AI Desktop Assistant

A powerful AI-powered desktop assistant built with Electron. Features voice control, screenshot capture, AI chat, and stealth mode for undetectable operation.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows-0078d7.svg)
![Electron](https://img.shields.io/badge/Electron-30+-47848f.svg)
![Version](https://img.shields.io/badge/version-3.1.0-brightgreen.svg)
![BitBlt](https://img.shields.io/badge/screenshot-BitBlt%20GDI-purple.svg)

---

## ⬇️ Download

**Latest Release: v3.2.0** — *Released September 23, 2026*

### 🔑 Licensed Version (with HaimuAi Server)
No API key needed — AI calls go through our server with your license key.

| Type | Link | Size |
|------|------|------|
| 🖥️ **Installer** (recommended) | [HaimuAi-Setup-3.2.0.exe](https://github.com/Himanshutomar03/Haimu-ai/releases/download/v3.2.0/HaimuAi-Setup-3.2.0.exe) | ~74 MB |
| 📦 **Portable** (no install needed) | [HaimuAi-Portable.exe](https://github.com/Himanshutomar03/Haimu-ai/releases/download/v3.2.0/HaimuAi-Portable.exe) | ~74 MB |

### 🆓 Free Mode — No Activation Key Required
Use your own **free** Gemini API key — no license, no server, no payment. Add multiple keys for automatic failover.

| Type | Link | Size |
|------|------|------|
| 🖥️ **Installer** | [HaimuAi-Setup-3.2.0.exe](https://github.com/Himanshutomar03/Haimu-ai/releases/download/v3.2.0/HaimuAi-Setup-3.2.0.exe) | ~74 MB |
| 📦 **Portable** | [HaimuAi-Portable.exe](https://github.com/Himanshutomar03/Haimu-ai/releases/download/v3.2.0/HaimuAi-Portable.exe) | ~74 MB |

**Free Mode Setup (3 steps):**
1. Download & run **either** version above
2. On the activation screen → press **✕** to close → click **⚙️** gear icon to open Settings
3. Under **API Keys** → paste your Gemini key → enable **Free Mode** → click **Save**

> 🔑 Get a **free** Gemini API key (no credit card) → [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

> 💡 **Tip:** Add 2–3 keys to enable automatic failover — HaimuAi switches instantly when one key hits its daily quota.

> 🔗 [View all releases](https://github.com/Himanshutomar03/Haimu-ai/releases)

---

## 🆕 What's New in v3.2.0

- **🆓 Free Mode** — Run HaimuAi with your own Gemini API key(s). No license or activation key needed.
- **🔑 Multiple API Keys** — Add unlimited keys in Settings → API Keys. Each key shows label, masked value, and current status.
- **⚡ Auto Key Rotation** — When any key hits its daily quota (429/403), HaimuAi instantly switches to the next available key and retries the request seamlessly — no interruption, no error shown.
- **🟡 Quota Badge** — Exhausted keys are visually marked "Quota Hit" in the Settings panel so you always know which keys are throttled.
- **⏰ 1-Hour Auto-Reset** — Exhausted keys are automatically re-eligible after 1 hour (Gemini's free-tier quota window).
- **📸 Screenshot Fix** — Packaged builds (NSIS installer, Portable .exe) now correctly run `screenshot.ps1` outside the ASAR archive. Fixes screenshot capture on all distributed builds.

---

## 🆕 What's New in v3.1.0

- **🛡️ Zero-Focus-Loss Screenshot** — Screen capture now uses Win32 GDI BitBlt at the driver level. No window hide/show, no focus events.
- **⚡ Always Active by Default** — `WS_EX_NOACTIVATE` enabled by default; clicking HaimuAi never steals OS focus.
- **🔒 Stronger Stealth on Show** — `showInactive()` instead of `show()` prevents `WM_ACTIVATE` signals.

---

## ✨ Features

- 🤖 **AI Chat** — Conversational AI assistant powered by your configured API
- 🎤 **Voice Control** — Hands-free interaction with speech recognition & text-to-speech
- 📸 **Screenshot Capture** — Win32 GDI BitBlt zero-focus capture + AI analysis
- ⌨️ **Auto-Type** — AI-generated text typed directly into any application
- 🕵️ **Stealth Mode** — Run invisibly in the background with hotkey activation
- 🛡️ **Guardian Process** — Keeps the app running with self-healing capabilities
- 🧩 **Always Active Mode** — Overlay that never triggers window-switch detection
- ⚙️ **Settings Panel** — Customize API keys, hotkeys, and behavior

---

## 📋 Prerequisites

- **Node.js** 18 or later — [Download](https://nodejs.org/)
- **Git** — [Download](https://git-scm.com/)
- Windows 10/11 (x64)

---

## 🚀 Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/Himanshutomar03/Haimu-ai.git
cd Haimu-ai
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run the app

```bash
# Normal mode
npm start

# Dev mode (with DevTools)
npm run dev

# Stealth mode (invisible, launched via hotkey)
npm run stealth
```

---

## ⌨️ Hotkeys

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Toggle show/hide |
| `Alt+A` | Capture screen & auto-answer |
| `Alt+L` | Toggle system audio listen |
| `Ctrl+Shift+A` | Toggle Always Active mode |
| `Ctrl+Shift+Q` | Force quit (kills guardians) |

---

## 🏗️ Build

Build a distributable Windows executable:

```bash
# NSIS installer + Portable exe
npm run build

# Portable only
npm run build:portable
```

Output goes to the `dist/` folder.

---

## 📁 Project Structure

```
haimuai/
├── main.js                  # Electron main process
├── preload.js               # Secure bridge between main & renderer
├── package.json
├── renderer/
│   ├── index.html           # Main UI
│   ├── styles.css           # Styling
│   ├── app.js               # Renderer entry point
│   ├── assets/
│   │   └── icon.png         # App icon
│   └── modules/
│       ├── ai-chat.js       # AI chat module
│       ├── auto-type.js     # Auto-type functionality
│       ├── screenshot.js    # Screenshot capture
│       ├── settings.js      # Settings management
│       └── voice.js         # Voice recognition & TTS
├── utils/
│   ├── stealth.js           # Stealth mode logic (Node)
│   ├── stealth.ps1          # Win32 EXSTYLE manipulation
│   ├── screenshot.ps1       # BitBlt screen capture (NEW)
│   ├── guardian.ps1         # Process guardian
│   ├── immortal-guardian.ps1 # Persistent guardian
│   ├── keyhook.ps1          # Global hotkey listener
│   └── ...                  # Other utility scripts
└── dist/                    # Build output (git-ignored)
```

---

## ⚙️ Configuration

After launching, open **Settings** to configure:

- **AI Provider** — Choose your AI backend
- **Hotkeys** — Customize keyboard shortcuts
- **Voice** — Select voice engine and language
- **Stealth** — Toggle stealth behaviors
- **Always Active** — Prevent focus stealing from exam browsers

---

## 📸 How Screenshot Capture Works (BitBlt)

HaimuAi v3.1 uses the **Win32 GDI BitBlt** API via a PowerShell script to capture the screen:

1. Gets the Desktop window handle (`GetDesktopWindow`)
2. Creates a compatible memory device context
3. Calls `BitBlt` to copy pixels from the screen DC to memory — zero OS events
4. Encodes as PNG and returns base64 to Electron
5. **No window activation, no focus events, no detection surface**

This is fundamentally different from Electron's `desktopCapturer` which creates a media stream and can trigger security scanners.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
