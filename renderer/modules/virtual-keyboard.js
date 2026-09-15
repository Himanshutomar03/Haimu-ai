// Virtual Keyboard — Floating, draggable, transparent, click-based input
// For Always Active mode where physical keyboard may not reach the renderer.

class VirtualKeyboard {
  constructor() {
    this.isVisible = false;
    this.targetInput = null;
    this.capsLock = false;
    this.shiftActive = false;
    this.container = null;
    this._alwaysActiveMode = false;
    this._dragState = null;
    this._build();
    this._listen();
  }

  _build() {
    this.container = document.createElement('div');
    this.container.id = 'virtualKeyboard';
    this.container.className = 'vk';
    this.container.innerHTML = this._renderLayout();
    document.body.appendChild(this.container);

    // Restore saved position
    const saved = localStorage.getItem('vk_pos');
    if (saved) {
      try {
        const { x, y } = JSON.parse(saved);
        this.container.style.left = x + 'px';
        this.container.style.top = y + 'px';
        this.container.style.bottom = 'auto';
        this.container.style.right = 'auto';
      } catch(e) {}
    }
  }

  _renderLayout() {
    const rows = [
      ['1','2','3','4','5','6','7','8','9','0','-','='],
      ['q','w','e','r','t','y','u','i','o','p'],
      ['a','s','d','f','g','h','j','k','l'],
      ['z','x','c','v','b','n','m',',','.'],
    ];
    const shiftMap = {
      '1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')',
      '-':'_','=':'+',',':'<','.':'>','/':'?',';':':',  "'":'"','[':'{',']':'}'
    };

    let h = '<div class="vk-grip" id="vkGrip">⠿</div>';
    h += '<button class="vk-x" id="vkClose">✕</button>';

    rows.forEach((row, i) => {
      h += '<div class="vk-r">';
      if (i === 3) h += '<btn class="vk-k vk-sp vk-shift" data-action="shift">⇧</btn>';
      row.forEach(k => {
        const s = shiftMap[k] || k.toUpperCase();
        h += `<btn class="vk-k" data-key="${k}" data-shift="${s}">${k}</btn>`;
      });
      if (i === 0) h += '<btn class="vk-k vk-w" data-action="backspace">⌫</btn>';
      if (i === 3) h += '<btn class="vk-k vk-sp" data-action="shift">⇧</btn>';
      h += '</div>';
    });

    h += '<div class="vk-r">';
    h += '<btn class="vk-k vk-sp" data-action="caps">Caps</btn>';
    h += '<btn class="vk-k vk-space" data-action="space"></btn>';
    h += '<btn class="vk-k vk-sp" data-action="enter">↵</btn>';
    h += '<btn class="vk-k vk-send" data-action="send">🚀</btn>';
    h += '</div>';

    return h;
  }

  _listen() {
    // Key clicks — use mousedown to prevent focus stealing
    this.container.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Drag grip
      if (e.target.closest('#vkGrip')) {
        this._startDrag(e);
        return;
      }
      // Close
      if (e.target.closest('#vkClose')) {
        this.hide();
        return;
      }

      const btn = e.target.closest('.vk-k');
      if (!btn) return;

      btn.classList.add('vk-tap');
      setTimeout(() => btn.classList.remove('vk-tap'), 100);

      const action = btn.dataset.action;
      if (action) {
        this._action(action);
      } else {
        const char = (this.capsLock || this.shiftActive) ? btn.dataset.shift : btn.dataset.key;
        this._insert(char);
        if (this.shiftActive) { this.shiftActive = false; this._updateKeys(); }
      }
    });

    // Drag handlers
    document.addEventListener('mousemove', (e) => this._onDrag(e));
    document.addEventListener('mouseup', () => this._stopDrag());

    // Always Active mode listener
    window.haimuai?.onAlwaysActiveChanged((active) => {
      this._alwaysActiveMode = active;
      if (active) this.show(); else this.hide();
    });

    // Show on textarea click in always-active mode
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#virtualKeyboard') && this._alwaysActiveMode &&
          (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) {
        this.targetInput = e.target;
        this.show();
      }
    });
  }

  // ---- Drag ----
  _startDrag(e) {
    const rect = this.container.getBoundingClientRect();
    this._dragState = { ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    this.container.style.transition = 'none';
  }
  _onDrag(e) {
    if (!this._dragState) return;
    const x = e.clientX - this._dragState.ox;
    const y = e.clientY - this._dragState.oy;
    this.container.style.left = x + 'px';
    this.container.style.top = y + 'px';
    this.container.style.bottom = 'auto';
    this.container.style.right = 'auto';
  }
  _stopDrag() {
    if (!this._dragState) return;
    this._dragState = null;
    this.container.style.transition = '';
    // Save position
    const rect = this.container.getBoundingClientRect();
    localStorage.setItem('vk_pos', JSON.stringify({ x: rect.left, y: rect.top }));
  }

  // ---- Actions ----
  _action(a) {
    switch(a) {
      case 'space':     this._insert(' '); break;
      case 'enter':     this._insert('\n'); break;
      case 'backspace': this._backspace(); break;
      case 'shift':
        this.shiftActive = !this.shiftActive;
        this._updateKeys();
        break;
      case 'caps':
        this.capsLock = !this.capsLock;
        this._updateKeys();
        break;
      case 'send':
        window.app?.sendMessage();
        break;
    }
  }

  _insert(char) {
    const el = this.targetInput || document.getElementById('userInput');
    if (!el) return;
    const s = el.selectionStart || 0, e = el.selectionEnd || 0;
    el.value = el.value.substring(0, s) + char + el.value.substring(e);
    el.selectionStart = el.selectionEnd = s + char.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  _backspace() {
    const el = this.targetInput || document.getElementById('userInput');
    if (!el) return;
    const s = el.selectionStart || 0, e = el.selectionEnd || 0;
    if (s !== e) {
      el.value = el.value.substring(0, s) + el.value.substring(e);
      el.selectionStart = el.selectionEnd = s;
    } else if (s > 0) {
      el.value = el.value.substring(0, s - 1) + el.value.substring(s);
      el.selectionStart = el.selectionEnd = s - 1;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  _updateKeys() {
    const on = this.shiftActive || this.capsLock;
    this.container.querySelectorAll('.vk-k:not(.vk-sp):not(.vk-space):not(.vk-w):not(.vk-send)').forEach(b => {
      if (b.dataset.key) b.textContent = on ? b.dataset.shift : b.dataset.key;
    });
    this.container.querySelectorAll('.vk-shift').forEach(b => b.classList.toggle('vk-on', this.shiftActive));
    const caps = this.container.querySelector('[data-action="caps"]');
    if (caps) caps.classList.toggle('vk-on', this.capsLock);
  }

  show() {
    this.isVisible = true;
    this.container.classList.add('vk-show');
    this.targetInput = document.getElementById('userInput');
  }
  hide() {
    this.isVisible = false;
    this.container.classList.remove('vk-show');
  }
  toggle() { this.isVisible ? this.hide() : this.show(); }
}

window.virtualKeyboard = new VirtualKeyboard();
