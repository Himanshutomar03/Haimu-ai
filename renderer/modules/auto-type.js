// Auto-Type Module - Simulates typing in other applications
class AutoTyper {
  constructor() {
    this.isTyping = false;
    this.isPaused = false;
    this.text = '';
    this.position = 0;
    this.speed = 50; // ms per character
    this.timer = null;
  }

  setSpeed(speed) {
    this.speed = speed;
  }

  async startTyping(text) {
    if (!text) return;
    
    this.text = text;
    this.position = 0;
    this.isTyping = true;
    this.isPaused = false;

    // Notify user to click where they want text typed
    window.app?.showToast('Click where you want to type, starting in 3 seconds...', 'info');
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    this.typeNextChar();
  }

  typeNextChar() {
    if (!this.isTyping || this.isPaused || this.position >= this.text.length) {
      if (this.position >= this.text.length) {
        this.isTyping = false;
        window.app?.showToast('Auto-typing complete!', 'success');
        window.app?.updateAutoTypeBtn(false);
      }
      return;
    }

    const char = this.text[this.position];
    
    // Use clipboard-based typing for reliability
    // This works by copying each character and simulating Ctrl+V
    // In a real implementation, you'd use robotjs or nut.js
    this.simulateKeypress(char);
    
    this.position++;
    this.timer = setTimeout(() => this.typeNextChar(), this.speed);
  }

  simulateKeypress(char) {
    // For Electron, we'd use robotjs in the main process
    // This is a simplified version using clipboard
    if (window.haimuai) {
      window.haimuai.writeClipboard(this.text.substring(0, this.position + 1));
    }
  }

  pause() {
    this.isPaused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resume() {
    if (this.isTyping && this.isPaused) {
      this.isPaused = false;
      this.typeNextChar();
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
