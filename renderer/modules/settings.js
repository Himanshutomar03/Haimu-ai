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
  }

  collectFromUI() {
    const el = (id) => document.getElementById(id);

    return {
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

  // Wire up theme buttons, typing speed, language
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
