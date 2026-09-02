# HaimuAi v3 — Stealth AI Desktop Assistant

A powerful AI-powered desktop assistant built with Electron. Features voice control, screenshot capture, AI chat, and stealth mode for undetectable operation.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows-0078d7.svg)
![Electron](https://img.shields.io/badge/Electron-30+-47848f.svg)

---

## ✨ Features

- 🤖 **AI Chat** — Conversational AI assistant powered by your configured API
- 🎤 **Voice Control** — Hands-free interaction with speech recognition & text-to-speech
- 📸 **Screenshot Capture** — Take and analyze screenshots with AI
- ⌨️ **Auto-Type** — AI-generated text typed directly into any application
- 🕵️ **Stealth Mode** — Run invisibly in the background with hotkey activation
- 🛡️ **Guardian Process** — Keeps the app running with self-healing capabilities
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
git clone https://github.com/YOUR_USERNAME/haimuai.git
cd haimuai
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

# Stealth mode (invisible)
npm run stealth
```

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
│   ├── stealth.js           # Stealth mode logic
│   ├── stealth.ps1          # PowerShell stealth launcher
│   ├── guardian.ps1          # Process guardian
│   ├── immortal-guardian.ps1 # Persistent guardian
│   ├── keyhook.ps1          # Global hotkey listener
│   └── ...                  # Other utility scripts
└── dist/                    # Build output (git-ignored)
```

---

## ⚙️ Configuration

After launching, open **Settings** to configure:

- **AI API Key** — Your API key for the AI provider
- **Hotkeys** — Customize keyboard shortcuts
- **Voice** — Select voice engine and language
- **Stealth** — Toggle stealth behaviors

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
