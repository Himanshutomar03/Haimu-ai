// Settings Module
class SettingsManager {
  constructor() {
    this.settings = {};
    this.isOpen = false;
    this._freeApiKeys = [];     // [{ label, key, provider }]
    this._freeModeEnabled = false;
    this._activeKeyIndex = 0;
  }

  async load() {
    try {
      this.settings = await window.haimuai.getSettings();
      this.applySettings();

      // Load free-mode keys
      const fm = await window.haimuai.getFreeMode();
      this._freeApiKeys = fm.keys || [];
      this._freeModeEnabled = fm.enabled && this._freeApiKeys.length > 0;
      this._activeKeyIndex = fm.activeIndex || 0;
      this.updateSettingsUI();

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

    // Typing speed
    if (this.settings.typingSpeed && window.autoTyper) {
      window.autoTyper.setSpeed(this.settings.typingSpeed);
    }

    // Default language
    if (this.settings.defaultLanguage) {
      const langSelect = document.getElementById('languageSelect');
      if (langSelect) langSelect.value = this.settings.defaultLanguage;
    }

    // Update settings panel UI
    this.updateSettingsUI();
  }

  updateSettingsUI() {
    const s = this.settings;
    const el = (id) => document.getElementById(id);

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

    // API keys UI
    this._renderApiKeys();
    const fmCheckbox = el('settingFreeModeEnabled');
    if (fmCheckbox) fmCheckbox.checked = this._freeModeEnabled;
    this._updateFreeModeStatus();
  }

  // ============================================================
  // API Keys Management (Free Mode)
  // ============================================================
  _renderApiKeys() {
    const list = document.getElementById('apiKeysList');
    if (!list) return;

    if (this._freeApiKeys.length === 0) {
      list.innerHTML = `<div class="api-keys-empty">No API keys added yet. Add your Gemini API key below to use Free Mode.</div>`;
      return;
    }

    // Pull exhausted-key info from live ai-chat instance
    const exhaustedKeys = window.aiChat?._exhaustedKeys || new Set();

    list.innerHTML = this._freeApiKeys.map((k, i) => {
      const isActive = i === this._activeKeyIndex;
      const isExhausted = exhaustedKeys.has(i);
      return `
        <div class="api-key-item ${isActive ? 'active-key' : ''} ${isExhausted ? 'exhausted-key' : ''}" data-index="${i}">
          <div class="api-key-item-info">
            <div class="api-key-item-label">
              ${isActive ? '<span class="api-key-active-dot"></span>' : ''}
              ${this._escapeHtml(k.label || `Key ${i + 1}`)}
              ${isExhausted ? '<span class="api-key-quota-badge">Quota Hit</span>' : ''}
            </div>
            <div class="api-key-item-value">${this._maskKey(k.key)}</div>
          </div>
          <div class="api-key-item-actions">
            ${!isActive ? `<button class="api-key-set-active-btn" data-index="${i}" title="Set as active key">✓ Use</button>` : '<span class="api-key-in-use">In Use</span>'}
            <button class="api-key-remove-btn" data-index="${i}" title="Remove this key">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Bind buttons
    list.querySelectorAll('.api-key-set-active-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._activeKeyIndex = parseInt(btn.dataset.index);
        // Also update live ai-chat instance
        if (window.aiChat) window.aiChat.freeApiKeyIndex = this._activeKeyIndex;
        this._renderApiKeys();
      });
    });
    list.querySelectorAll('.api-key-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index);
        this._freeApiKeys.splice(idx, 1);
        if (this._activeKeyIndex >= this._freeApiKeys.length) {
          this._activeKeyIndex = Math.max(0, this._freeApiKeys.length - 1);
        }
        this._renderApiKeys();
        this._updateFreeModeStatus();
      });
    });
  }

  _maskKey(key) {
    if (!key || key.length < 8) return '••••••••';
    return key.slice(0, 6) + '••••••••' + key.slice(-4);
  }

  _escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  _updateFreeModeStatus() {
    const badge = document.getElementById('freeModeStatusBadge');
    if (!badge) return;

    const hasKeys = this._freeApiKeys.length > 0;
    const enabled = this._freeModeEnabled && hasKeys;

    if (enabled) {
      badge.textContent = `Free Mode • ${this._freeApiKeys.length} key${this._freeApiKeys.length > 1 ? 's' : ''}`;
      badge.className = 'settings-badge active';
    } else {
      badge.textContent = 'Server Mode';
      badge.className = 'settings-badge';
    }
  }

  addApiKey(label, key) {
    if (!key || !key.trim()) return false;
    this._freeApiKeys.push({
      label: (label || `Key ${this._freeApiKeys.length + 1}`).trim(),
      key: key.trim(),
      provider: 'gemini',
    });
    this._renderApiKeys();
    this._updateFreeModeStatus();
    return true;
  }

  async saveFreeModeSettings() {
    const freeModeEnabled = document.getElementById('settingFreeModeEnabled')?.checked ?? false;
    this._freeModeEnabled = freeModeEnabled && this._freeApiKeys.length > 0;

    try {
      await window.haimuai.saveFreeMode({
        enabled: this._freeModeEnabled,
        keys: this._freeApiKeys,
        activeIndex: this._activeKeyIndex,
      });

      // Reload free mode in ai-chat
      if (window.aiChat) {
        await window.aiChat._refreshFreeMode();
      }

      return true;
    } catch (e) {
      console.error('Failed to save free mode:', e);
      return false;
    }
  }

  collectFromUI() {
    const el = (id) => document.getElementById(id);

    return {
      opacity: (parseInt(el('settingOpacity')?.value) || 95) / 100,
      fontSize: parseInt(el('settingFontSize')?.value) || 14,
      alwaysOnTop: el('settingAlwaysOnTop')?.checked ?? true,
      autoFocus: el('settingAutoFocus')?.checked ?? true,
      alwaysActive: el('settingAlwaysActive')?.checked ?? true,
      typingSpeed: parseInt(el('settingTypingSpeed')?.value) || 50,
      defaultLanguage: el('settingDefaultLanguage')?.value || 'javascript',
      theme: document.documentElement.getAttribute('data-theme') || 'dark'
    };
  }

  // Wire up theme buttons, API keys, free mode
  bindProviderUI() {
    // Listen for license revocation from main process
    if (window.haimuai?.onLicenseRevoked) {
      window.haimuai.onLicenseRevoked((reason) => {
        // Show a banner telling user their license was revoked
        const banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ef4444;color:#fff;text-align:center;padding:12px 16px;font-size:14px;font-weight:600;';
        banner.textContent = `⚠️ License Revoked: ${reason}. HaimuAi will close in 3 seconds.`;
        document.body.appendChild(banner);
      });
    }

    // Add API key button
    document.getElementById('btnAddApiKey')?.addEventListener('click', () => {
      const labelEl = document.getElementById('newApiKeyLabel');
      const keyEl = document.getElementById('newApiKeyValue');
      const label = labelEl?.value.trim();
      const key = keyEl?.value.trim();

      if (!key) {
        if (keyEl) { keyEl.classList.add('input-error'); setTimeout(() => keyEl.classList.remove('input-error'), 1500); }
        return;
      }

      const added = this.addApiKey(label || `Key ${this._freeApiKeys.length}`, key);
      if (added) {
        if (labelEl) labelEl.value = '';
        if (keyEl) keyEl.value = '';
      }
    });

    // Enter key on API key input
    document.getElementById('newApiKeyValue')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnAddApiKey')?.click();
    });

    // Free mode toggle
    document.getElementById('settingFreeModeEnabled')?.addEventListener('change', (e) => {
      this._freeModeEnabled = e.target.checked && this._freeApiKeys.length > 0;
      this._updateFreeModeStatus();
    });

    // Get free key button — opens Google AI Studio
    document.getElementById('btnGetFreeKey')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.open('https://aistudio.google.com/apikey', '_blank');
    });
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
