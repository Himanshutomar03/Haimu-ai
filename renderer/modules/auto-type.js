// Auto-Type Module — Types AI responses into external applications
// Uses main process IPC → PowerShell SendKeys for real keystroke simulation
// This allows typing AI answers directly into exam browser textboxes

class AutoTyper {
  constructor() {
    this.isTyping = false;
    this.isPaused = false;
    this.text = '';
    this.position = 0;
    this.speed = 50; // ms per character
    this.timer = null;
    this.countdownTimer = null;
    this.delay = 3; // seconds before typing starts
  }

  setSpeed(speed) {
    this.speed = Math.max(10, Math.min(300, speed));
  }

  async startTyping(text) {
    if (!text) return;

    // Clean the text: strip markdown formatting for clean typing
    this.text = this._cleanMarkdown(text);
    this.position = 0;
    this.isTyping = true;
    this.isPaused = false;

    // Countdown — user needs to click where they want text typed
    window.app?.showToast(`⌨️ Click target input field! Typing starts in ${this.delay}s...`, 'info');
    
    // Hide HaimuAi window so user can click on the exam browser
    try { window.haimuai.minimize(); } catch(e) {}

    await new Promise(resolve => setTimeout(resolve, this.delay * 1000));

    // Start typing character by character
    this._typeNextChunk();
  }

  _typeNextChunk() {
    if (!this.isTyping || this.isPaused) return;
    if (this.position >= this.text.length) {
      this.isTyping = false;
      // Show HaimuAi again
      window.app?.showToast('✅ Auto-typing complete!', 'success');
      window.app?.updateAutoTypeBtn(false);
      return;
    }

    // Type in small chunks for reliability (5-15 chars at a time)
    const chunkSize = Math.min(10, this.text.length - this.position);
    const chunk = this.text.substring(this.position, this.position + chunkSize);
    this.position += chunkSize;

    // Send chunk to main process for real keystroke simulation
    window.haimuai.simulateTyping(chunk);

    // Update progress
    const progress = Math.round((this.position / this.text.length) * 100);
    if (progress % 20 === 0) {
      window.app?.showToast(`⌨️ Typing... ${progress}%`, 'info');
    }

    // Schedule next chunk
    this.timer = setTimeout(() => this._typeNextChunk(), this.speed * chunkSize);
  }

  // Strip markdown formatting for clean plaintext typing
  _cleanMarkdown(text) {
    return text
      // Remove code block markers
      .replace(/```[\w]*\n?/g, '')
      // Remove bold/italic markers
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      // Remove headers
      .replace(/^#+\s+/gm, '')
      // Remove bullet points (keep text)
      .replace(/^[\-\*]\s+/gm, '- ')
      // Remove inline code backticks
      .replace(/`(.+?)`/g, '$1')
      // Collapse multiple newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  pause() {
    this.isPaused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    window.app?.showToast('⏸️ Auto-type paused', 'info');
  }

  resume() {
    if (this.isTyping && this.isPaused) {
      this.isPaused = false;
      window.app?.showToast('▶️ Auto-type resumed', 'info');
      this._typeNextChunk();
    }
  }

  stop() {
    this.isTyping = false;
    this.isPaused = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.text = '';
    this.position = 0;
    window.app?.updateAutoTypeBtn(false);
  }

  toggle(text) {
    if (this.isTyping) {
      if (this.isPaused) {
        this.resume();
        return 'resumed';
      } else {
        this.pause();
        return 'paused';
      }
    } else {
      this.startTyping(text);
      return 'started';
    }
  }

  getStatus() {
    if (!this.isTyping) return 'idle';
    if (this.isPaused) return 'paused';
    return 'typing';
  }

  getProgress() {
    if (!this.text) return 0;
    return Math.round((this.position / this.text.length) * 100);
  }
}

window.autoTyper = new AutoTyper();
