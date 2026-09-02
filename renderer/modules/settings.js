// Settings Module
class SettingsManager {
  constructor() {
    this.settings = {};
    this.isOpen = false;
  }

  async load() {
    try {
      this.settings = await window.haimuai.getSettings();
      this.applySettings();
      return this.settings;
    } catch (error) {
      console.error('Failed to load settings:', error);
      return {};
    }
  }

  async save(newSettings) {
    try {
      Object.assign(this.settings, newSettings);
      await window.haimuai.saveSettings(newSettings);
      this.applySettings();
      return true;
    } catch (error) {
      console.error('Failed to save settings:', error);
      return false;
    }
  }

  applySettings() {
    // Theme
    if (this.settings.theme) {
      document.documentElement.setAttribute('data-theme', this.settings.theme);
    }

    // Font size
    if (this.settings.fontSize) {
      document.documentElement.style.setProperty('--font-size-base', `${this.settings.fontSize}px`);
    }

    // AI provider + keys
    if (window.aiChat) {
      const provider = this.settings.provider || 'gemini';
      window.aiChat.setProvider(provider);
      // Multi-key pool (preferred) — fall back to legacy single key
      const keys = this.settings.geminiApiKeys;
      if (Array.isArray(keys) && keys.length > 0) {
        window.aiChat.setApiKeys(keys);
      } else if (this.settings.apiKey) {
        window.aiChat.setApiKey(this.settings.apiKey);
      }
      if (this.settings.ollamaModel) window.aiChat.setOllamaModel(this.settings.ollamaModel);
    }

    // Default language
    if (this.settings.defaultLanguage) {
      const langSelect = document.getElementById('languageSelect');
      if (langSelect) langSelect.value = this.settings.defaultLanguage;
    }

    // Typing speed
    if (this.settings.typingSpeed && window.autoTyper) {
      window.autoTyper.setSpeed(this.settings.typingSpeed);
    }

    // Update settings panel UI
    this.updateSettingsUI();
  }

  updateSettingsUI() {
    const s = this.settings;
    const el = (id) => document.getElementById(id);

    // Multi-key pool
    const keys = Array.isArray(s.geminiApiKeys) && s.geminiApiKeys.length > 0
      ? s.geminiApiKeys
      : (s.apiKey ? [s.apiKey] : ['']);
    this.renderApiKeysList(keys);

    if (el('settingOllamaModel')) el('settingOllamaModel').value = s.ollamaModel || 'llama3.2';
    if (el('settingOpacity')) {
      el('settingOpacity').value = (s.opacity || 0.95) * 100;
      if (el('opacityValue')) el('opacityValue').textContent = Math.round((s.opacity || 0.95) * 100) + '%';
    }
    if (el('settingFontSize')) {
      el('settingFontSize').value = s.fontSize || 14;
      if (el('fontSizeValue')) el('fontSizeValue').textContent = (s.fontSize || 14) + 'px';
    }
    if (el('settingAlwaysOnTop')) el('settingAlwaysOnTop').checked = s.alwaysOnTop !== false;
    if (el('settingAutoFocus')) el('settingAutoFocus').checked = s.autoFocus !== false;
    if (el('settingAlwaysActive')) el('settingAlwaysActive').checked = s.alwaysActive === true;
    if (el('settingTypingSpeed')) {
      el('settingTypingSpeed').value = s.typingSpeed || 50;
      if (el('typingSpeedValue')) el('typingSpeedValue').textContent = (s.typingSpeed || 50) + 'ms';
    }
    if (el('settingDefaultLanguage')) el('settingDefaultLanguage').value = s.defaultLanguage || 'javascript';

    // Theme buttons
    document.querySelectorAll('.toggle-btn[data-theme]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === (s.theme || 'dark'));
    });

    // Provider toggle
    this._applyProviderUI(s.provider || 'gemini');
  }

  /** Render the dynamic API-key list rows */
  renderApiKeysList(keys) {
    const list = document.getElementById('apiKeysList');
    if (!list) return;
    list.innerHTML = '';

    const activeIdx = window.aiChat ? window.aiChat._keyIndex : 0;

    keys.forEach((key, i) => {
      const row = document.createElement('div');
      row.className = 'api-key-row';
      row.dataset.index = i;

      const isActive = (i === activeIdx);
      row.innerHTML = `
        <div class="api-key-row-left">
          <span class="api-key-num ${isActive ? 'active' : ''}">${i + 1}</span>
          <input type="password" class="settings-input api-key-input"
            data-key-index="${i}"
            value="${key}"
            placeholder="AIza..." />
        </div>
        <div class="api-key-row-right">
          ${isActive ? '<span class="api-key-status-dot">●</span>' : ''}
          <button class="api-key-remove-btn" data-remove="${i}" ${keys.length === 1 ? 'disabled' : ''}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>`;
      list.appendChild(row);
    });

    // Update rotation info + active badge
    const badge = document.getElementById('apiKeyActiveBadge');
    const rotInfo = document.getElementById('apiKeyRotationInfo');
    if (badge) badge.textContent = `Key ${activeIdx + 1} of ${keys.length} active`;
    if (rotInfo) rotInfo.style.display = keys.length > 1 ? 'flex' : 'none';

    // Wire remove buttons
    list.querySelectorAll('.api-key-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.remove);
        const current = this._collectKeys();
        if (current.length <= 1) return;
        current.splice(idx, 1);
        this.renderApiKeysList(current);
      });
    });
  }

  /** Read all key inputs from the dynamic list */
  _collectKeys() {
    const inputs = document.querySelectorAll('.api-key-input');
    return Array.from(inputs).map(inp => inp.value.trim()).filter(Boolean);
  }

  _applyProviderUI(provider) {
    const geminiBtn = document.getElementById('providerGeminiBtn');
    const ollamaBtn = document.getElementById('providerOllamaBtn');
    const geminiSection = document.getElementById('geminiSection');
    const ollamaSection = document.getElementById('ollamaSection');
    if (!geminiBtn) return;

    if (provider === 'ollama') {
      geminiBtn.classList.remove('active');
      ollamaBtn.classList.add('active');
      if (geminiSection) geminiSection.style.display = 'none';
      if (ollamaSection) ollamaSection.style.display = '';
    } else {
      ollamaBtn.classList.remove('active');
      geminiBtn.classList.add('active');
      if (geminiSection) geminiSection.style.display = '';
      if (ollamaSection) ollamaSection.style.display = 'none';
    }
  }

  collectFromUI() {
    const el = (id) => document.getElementById(id);
    const activeProvider = document.querySelector('.toggle-btn[data-provider].active')?.dataset.provider || 'gemini';
    const geminiApiKeys = this._collectKeys();

    return {
      apiKey: geminiApiKeys[0] || '',        // legacy single-key field
      geminiApiKeys,                          // new multi-key field
      ollamaModel: el('settingOllamaModel')?.value || 'llama3.2',
      provider: activeProvider,
      opacity: (parseInt(el('settingOpacity')?.value) || 95) / 100,
      fontSize: parseInt(el('settingFontSize')?.value) || 14,
      alwaysOnTop: el('settingAlwaysOnTop')?.checked ?? true,
      autoFocus: el('settingAutoFocus')?.checked ?? true,
      alwaysActive: el('settingAlwaysActive')?.checked ?? false,
      typingSpeed: parseInt(el('settingTypingSpeed')?.value) || 50,
      defaultLanguage: el('settingDefaultLanguage')?.value || 'javascript',
      theme: document.documentElement.getAttribute('data-theme') || 'dark'
    };
  }

  // Wire up provider toggle buttons, Ollama model chips, and API-key add button
  bindProviderUI() {
    // Provider buttons
    document.querySelectorAll('.toggle-btn[data-provider]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.toggle-btn[data-provider]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._applyProviderUI(btn.dataset.provider);
      });
    });

    // Add API key button
    const addKeyBtn = document.getElementById('btnAddApiKey');
    if (addKeyBtn) {
      addKeyBtn.addEventListener('click', () => {
        const current = this._collectKeys();
        current.push('');  // blank slot
        this.renderApiKeysList(current);
        // Focus the new input
        const inputs = document.querySelectorAll('.api-key-input');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      });
    }

    // Listen for live key rotation events from ai-chat.js
    window.addEventListener('api-key-rotated', (e) => {
      const { keyIndex, total } = e.detail;
      const badge = document.getElementById('apiKeyActiveBadge');
      if (badge) badge.textContent = `Key ${keyIndex + 1} of ${total} active`;
      const rotText = document.getElementById('apiKeyRotationText');
      if (rotText) rotText.textContent = `Switched to key ${keyIndex + 1} — quota exceeded on previous`;
      // Re-render to update active dot
      const keys = this._collectKeys();
      // Temporarily update _keyIndex in UI without re-reading all settings
      this.renderApiKeysList(keys.length > 0 ? keys : (window.aiChat?.apiKeys || []));
    });

    // Ollama model quick-pick chips
    document.querySelectorAll('[data-model]').forEach(chip => {
      chip.addEventListener('click', () => {
        const input = document.getElementById('settingOllamaModel');
        if (input) input.value = chip.dataset.model;
      });
    });

    // Test Ollama connection button
    const testBtn = document.getElementById('btnTestOllama');
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        const dot = document.getElementById('ollamaStatusDot');
        const txt = document.getElementById('ollamaStatusText');
        if (dot) dot.textContent = '🔄';
        if (txt) txt.textContent = 'Testing…';
        testBtn.disabled = true;

        try {
          const result = await window.aiChat.testOllamaConnection();
          if (result.ok) {
            if (dot) dot.textContent = '🟢';
            const modelList = result.models.length > 0
              ? `Available: ${result.models.slice(0, 4).join(', ')}`
              : 'No models pulled yet — run: ollama pull llama3.2';
            if (txt) txt.textContent = `Ollama running! ${modelList}`;
          } else {
            if (dot) dot.textContent = '🔴';
            if (txt) txt.textContent = `Not running: ${result.error}`;
          }
        } catch (e) {
          if (dot) dot.textContent = '🔴';
          if (txt) txt.textContent = `Error: ${e.message}`;
        } finally {
          testBtn.disabled = false;
        }
      });
    }
  }

  open() {
    this.isOpen = true;
    document.getElementById('settingsOverlay')?.classList.add('active');
  }

  close() {
    this.isOpen = false;
    document.getElementById('settingsOverlay')?.classList.remove('active');
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  get(key) {
    return this.settings[key];
  }
}

window.settingsManager = new SettingsManager();
