const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('haimuai', {
  // Window controls
  minimize: () => ipcRenderer.send('minimize-window'),
  close: () => ipcRenderer.send('close-window'),
  forceQuit: () => ipcRenderer.send('force-quit'),
  maximize: () => ipcRenderer.send('maximize-window'),

  // License
  activateLicense: (key) => ipcRenderer.invoke('activate-license', key),
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  getLicenseToken: () => ipcRenderer.invoke('get-license-token'),
  saveLicenseToken: (token) => ipcRenderer.invoke('save-license-token', token),

  // Free Mode (user-supplied API keys, no license needed)
  getFreeMode: () => ipcRenderer.invoke('get-free-mode'),
  saveFreeMode: (data) => ipcRenderer.invoke('save-free-mode', data),
  getFreeModeActive: () => ipcRenderer.invoke('get-free-mode-active'),

  // ChatGPT Session Link
  linkChatGPT: () => ipcRenderer.invoke('link-chatgpt'),
  getChatGPTToken: () => ipcRenderer.invoke('get-chatgpt-token'),
  saveChatGPTToken: (token) => ipcRenderer.invoke('save-chatgpt-token', token),
  clearChatGPTToken: () => ipcRenderer.invoke('clear-chatgpt-token'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Screenshot
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),

  // Clipboard
  getClipboard: () => ipcRenderer.invoke('get-clipboard'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),

  // Auto-Type — real keystroke simulation in foreground window
  simulateTyping: (text) => ipcRenderer.invoke('simulate-typing', text),

  // Safe mode
  toggleSafeMode: () => ipcRenderer.invoke('toggle-safe-mode'),
  getSafeMode: () => ipcRenderer.invoke('get-safe-mode'),

  // Ghost mode (ultra-stealth — near-invisible window)
  toggleGhostMode: () => ipcRenderer.invoke('toggle-ghost-mode'),
  getGhostMode: () => ipcRenderer.invoke('get-ghost-mode'),

  // Always Active mode — prevents focus stealing from exam browser
  toggleAlwaysActive: () => ipcRenderer.invoke('toggle-always-active'),
  getAlwaysActive: () => ipcRenderer.invoke('get-always-active'),

  // ── Affinity Bypass — clears target's WDA_EXCLUDEFROMCAPTURE ──
  getAffinityStatus: () => ipcRenderer.invoke('get-affinity-status'),
  forceAffinityReinject: () => ipcRenderer.invoke('force-affinity-reinject'),
  captureTargetWindow: () => ipcRenderer.invoke('capture-target-window'),
  startAffinityBypass: () => ipcRenderer.invoke('start-affinity-bypass'),
  stopAffinityBypass: () => ipcRenderer.invoke('stop-affinity-bypass'),

  // ── SEB Bypass toggle ──
  getSebBypassEnabled: () => ipcRenderer.invoke('get-seb-bypass-enabled'),
  setSebBypassEnabled: (enabled) => ipcRenderer.invoke('set-seb-bypass-enabled', enabled),

  // Event listeners
  onSafeModeChanged: (callback) => ipcRenderer.on('safe-mode-changed', (_, value) => callback(value)),
  onInteractionSafeModeChanged: (callback) => ipcRenderer.on('interaction-safe-mode-changed', (_, value) => callback(value)),
  onGhostModeChanged: (callback) => ipcRenderer.on('ghost-mode-changed', (_, value) => callback(value)),
  onAlwaysActiveChanged: (callback) => ipcRenderer.on('always-active-changed', (_, value) => callback(value)),
  onScreenshotTaken: (callback) => ipcRenderer.on('screenshot-taken', (_, data) => callback(data)),
  onAiCommand: (callback) => ipcRenderer.on('ai-command', (_, command) => callback(command)),
  onToggleVoice: (callback) => ipcRenderer.on('toggle-voice', () => callback()),
  onToggleAutoType: (callback) => ipcRenderer.on('toggle-auto-type', () => callback()),
  onOpenSettings: (callback) => ipcRenderer.on('open-settings', () => callback()),
  onFullPageScreenshot: (callback) => ipcRenderer.on('take-full-page-screenshot', () => callback()),
  onAnswerScreenshot: (callback) => ipcRenderer.on('answer-screenshot', (_, data) => callback(data)),
  onToggleListen: (callback) => ipcRenderer.on('toggle-listen', () => callback()),
  onLicenseRevoked: (callback) => ipcRenderer.on('license-revoked', (_, reason) => callback(reason)),
  onAffinityStatus: (callback) => ipcRenderer.on('affinity-status', (_, status) => callback(status)),
  onSebModeChanged: (callback) => ipcRenderer.on('seb-mode-changed', (_, active) => callback(active)),
  onChatGPTLinked: (callback) => ipcRenderer.on('chatgpt-session-token', (_, token) => callback(token)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});

