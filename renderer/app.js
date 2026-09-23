// HaimuAi - Main Application Controller
class HaimuAiApp {
  constructor() {
    this.currentCommand = 'general';
    this.lastAIResponse = '';
    this.messageCount = 0;
    this.toastTimer = null;
    this.pendingAttachments = []; // [{id, dataUrl, source}]
    this._attachNextId = 1;
    this.interviewPdfText = '';  // Extracted text from uploaded JD/question paper
    this.init();
  }

  async init() {
    // Load settings
    await window.settingsManager.load();

    // Setup event listeners
    this.setupTitleBar();
    this.setupQuickActions();
    this.setupInput();
    this.setupSettings();
    this.setupScreenshot();
    this.setupAttachments();
    this.setupVoice();
    this.setupListen();
    this.setupDragDrop();
    this.setupIPC();
    this.setupKeyboard();
    this.setupResume();
    this.setupInterview();
    this.setupInterviewPdf();
    this.setupHistory();

    // Load saved resume
    const savedResume = localStorage.getItem('haimuai_resume');
    if (savedResume) {
      window.aiChat.setResume(savedResume);
      this.updateResumeUI(true);
    }

    // Load chat sessions
    window.aiChat.loadSessions();

    // Auto-focus input (only if autoFocus is enabled AND alwaysActive is false)
    if (window.settingsManager.get('autoFocus')) {
      window.haimuai?.getAlwaysActive?.().then(active => {
        if (!active) document.getElementById('userInput')?.focus();
      });
    }

    // Listen for free-mode API key auto-switch events
    document.addEventListener('free-key-switched', (e) => {
      const label = e.detail?.label || 'next key';
      this.showToast(`🔑 Quota limit hit — auto-switched to "${label}"`, 'warning');
    });
  }

  // ========================================
  // Title Bar
  // ========================================
  setupTitleBar() {
    document.getElementById('btnMinimize')?.addEventListener('click', () => window.haimuai.minimize());
    document.getElementById('btnClose')?.addEventListener('click', () => window.haimuai.close());
    document.getElementById('btnMaximize')?.addEventListener('click', () => window.haimuai.maximize());
    
    document.getElementById('safeModeIndicator')?.addEventListener('click', async () => {
      const safeMode = await window.haimuai.toggleSafeMode();
      this.updateSafeModeUI(safeMode);
    });

    document.getElementById('ghostIndicator')?.addEventListener('click', async () => {
      const ghostMode = await window.haimuai.toggleGhostMode();
      this.updateGhostModeUI(ghostMode);
    });

    document.getElementById('alwaysActiveIndicator')?.addEventListener('click', async () => {
      const alwaysActive = await window.haimuai.toggleAlwaysActive();
      this.updateAlwaysActiveUI(alwaysActive);
      this.showToast(
        alwaysActive
          ? '🔒 Always Active ON — interactions won\'t trigger window switch'
          : '🔓 Always Active OFF — normal focus behavior',
        'info'
      );
    });

    // Quick Opacity Control
    const opacityIndicator = document.getElementById('opacityIndicator');
    const opacityWrapper = document.getElementById('quickOpacityWrapper');
    const opacitySlider = document.getElementById('quickOpacitySlider');
    const opacityValue = document.getElementById('quickOpacityValue');

    opacityIndicator?.addEventListener('click', () => {
      const isVisible = opacityWrapper?.classList.toggle('visible');
      opacityIndicator.classList.toggle('active', isVisible);
    });

    opacitySlider?.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      if (opacityValue) opacityValue.textContent = val + '%';
      // Apply live to window
      window.haimuai.saveSettings({ opacity: val / 100 });
    });

    // Initialize slider from saved settings
    const savedOpacity = window.settingsManager?.get('opacity');
    if (savedOpacity && opacitySlider) {
      const pct = Math.round(savedOpacity * 100);
      opacitySlider.value = pct;
      if (opacityValue) opacityValue.textContent = pct + '%';
    }
  }

  updateSafeModeUI(active) {
    const indicator = document.getElementById('safeModeIndicator');
    if (indicator) {
      indicator.classList.toggle('active', active);
    }
  }

  updateGhostModeUI(active) {
    document.body.classList.toggle('ghost-mode', active);
    const indicator = document.getElementById('ghostIndicator');
    if (indicator) {
      indicator.classList.toggle('active', active);
    }
  }

  updateAlwaysActiveUI(active) {
    const indicator = document.getElementById('alwaysActiveIndicator');
    if (indicator) {
      indicator.classList.toggle('active', active);
    }
    // Sync the settings checkbox
    const checkbox = document.getElementById('settingAlwaysActive');
    if (checkbox) {
      checkbox.checked = active;
    }
  }

  // ========================================
  // Quick Actions
  // ========================================
  setupQuickActions() {
    document.querySelectorAll('.action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const command = btn.dataset.command;
        
        if (command === 'screenshot') {
          this.handleScreenshot();
          return;
        }
        if (command === 'answer') {
          this.handleAnswerQuestion();
          return;
        }
        if (command === 'resume') {
          this.openResumePanel();
          return;
        }
        if (command === 'interview') {
          if (window.aiChat.isInterviewActive() || window.aiChat.isOnlineInterviewActive()) {
            if (window.aiChat.isOnlineInterviewActive()) {
              this.stopOnlineInterview();
            } else {
              this.stopInterview();
            }
          } else {
            this.openPanel('interviewOverlay');
          }
          return;
        }
        if (command === 'history') {
          this.openHistoryPanel();
          return;
        }
        if (command === 'listen') {
          this.toggleListen();
          return;
        }
        if (command === 'newchat') {
          this.newChatAction();
          return;
        }

        // Toggle active state
        document.querySelectorAll('.action-btn:not(.resume-btn):not(.interview-btn):not(.history-btn)').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentCommand = command;
        
        const input = document.getElementById('userInput');
        if (input) {
          input.placeholder = this.getPlaceholder(command);
          input.focus();
        }
      });
    });
  }

  getPlaceholder(command) {
    if (window.aiChat?.isInterviewActive()) {
      return 'Type your answer... (Enter to send)';
    }
    if (window.aiChat?.isOnlineInterviewActive()) {
      return 'Type a question or press Ctrl+4 to capture screen...';
    }
    const placeholders = {
      explain: 'Paste code or ask what you want explained...',
      debug: 'Paste code with bugs to debug...',
      generate: 'Describe what code you need...',
      practice: 'What topic do you want to practice?',
      general: 'Ask anything... (Enter to send, Shift+Enter for new line)'
    };
    return placeholders[command] || placeholders.general;
  }

  // ========================================
  // Input Area
  // ========================================
  setupInput() {
    const input = document.getElementById('userInput');
    const sendBtn = document.getElementById('btnSend');
    const charCount = document.getElementById('charCount');
    const clearBtn = document.getElementById('btnClear');
    const autoTypeBtn = document.getElementById('btnAutoType');
    const clipboardBtn = document.getElementById('btnClipboard');

    // Auto-resize textarea
    input?.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      if (charCount) charCount.textContent = input.value.length;
    });

    // Send on Enter, Shift+Enter for new line
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
      if (e.ctrlKey && e.key === 'Backspace') {
        e.preventDefault();
        this.clearChat();
      }
    });

    sendBtn?.addEventListener('click', () => this.sendMessage());

    clearBtn?.addEventListener('click', () => this.clearChat());

    autoTypeBtn?.addEventListener('click', () => {
      if (this.lastAIResponse) {
        const status = window.autoTyper.toggle(this.lastAIResponse);
        this.updateAutoTypeBtn(status !== 'idle');
        this.showToast(`Auto-type ${status}`, 'info');
      } else {
        this.showToast('No AI response to type', 'warning');
      }
    });

    clipboardBtn?.addEventListener('click', async () => {
      const clipboard = await window.haimuai.getClipboard();
      if (clipboard.type === 'text' && clipboard.data) {
        input.value += clipboard.data;
        input.dispatchEvent(new Event('input'));
        this.showToast('Clipboard content pasted', 'success');
      } else if (clipboard.type === 'image') {
        this.showToast('Image clipboard detected - use screenshot instead', 'info');
      }
    });
  }

  updateAutoTypeBtn(active) {
    const btn = document.getElementById('btnAutoType');
    btn?.classList.toggle('active', active);
  }

  // ========================================
  // Messages
  // ========================================
  async sendMessage() {
    const input = document.getElementById('userInput');
    const message = input?.value.trim();
    const hasAttachments = this.pendingAttachments.length > 0;

    // Must have either text or attachments
    if (!message && !hasAttachments) return;

    const language = document.getElementById('languageSelect')?.value || 'javascript';

    // Hide welcome screen
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'none';

    // Snapshot and clear attachments before async ops
    const attachments = [...this.pendingAttachments];
    this.pendingAttachments = [];
    this.renderAttachmentsStrip();

    // Build user message display (with image previews if any)
    const displayText = message || '📸 Analyzing screenshot(s)...';
    const userMsgId = this.addMessage('user', displayText, false, attachments);

    input.value = '';
    input.style.height = 'auto';
    const charCountEl = document.getElementById('charCount');
    if (charCountEl) charCountEl.textContent = '0';

    // Add AI typing indicator
    const aiMsgId = this.addMessage('ai', null, true);

    try {
      let fullResponse = '';

      if (attachments.length > 0) {
        // Vision mode — send images + optional text to AI
        const images = attachments.map(a => a.dataUrl);
        const question = message || 'What do you see in this screenshot? Describe and help the user.';
        fullResponse = await window.aiChat.analyzeScreenshots(images, question, language, true);
        this.lastAIResponse = fullResponse;
        this.updateMessage(aiMsgId, fullResponse, true);
      } else {
        // Text-only mode
        await window.aiChat.sendMessage(
          message,
          this.currentCommand,
          language,
          (chunk, fullText) => {
            fullResponse = fullText;
            this.updateMessage(aiMsgId, fullText);
          }
        );
        this.lastAIResponse = fullResponse;
        this.updateMessage(aiMsgId, fullResponse, true);
      }

    } catch (error) {
      this.updateMessage(aiMsgId, `❌ **Error:** ${error.message}`, true);
      console.error('AI Error:', error);
    }

    // Reset command to general after use
    if (this.currentCommand !== 'general') {
      document.querySelectorAll('.action-btn').forEach(b => b.classList.remove('active'));
      this.currentCommand = 'general';
      input.placeholder = this.getPlaceholder('general');
    }
  }

  addMessage(role, content, isTyping = false, attachments = []) {
    const messages = document.getElementById('messages');
    const id = `msg-${++this.messageCount}`;
    
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.id = id;

    if (role === 'user') {
      // Build image thumbnails strip if attachments present
      const imagesHtml = attachments.length > 0
        ? `<div class="msg-attachments">${attachments.map(a =>
            `<img src="${a.dataUrl}" class="msg-attachment-thumb" alt="screenshot">`
          ).join('')}</div>`
        : '';
      div.innerHTML = `
        <div class="message-avatar">U</div>
        <div class="message-content">
          <div class="message-header">
            <span class="message-name">You</span>
            <span class="message-time">${time}</span>
          </div>
          ${imagesHtml}
          <div class="message-body">${this.escapeHtml(content)}</div>
        </div>
      `;
    } else {
      div.innerHTML = `
        <div class="message-avatar">
          <img src="assets/icon.png" alt="AI">
        </div>
        <div class="message-content">
          <div class="message-header">
            <span class="message-name">HaimuAi</span>
            <span class="message-time">${time}</span>
          </div>
          <div class="message-body">
            ${isTyping ? '<div class="typing-indicator"><span></span><span></span><span></span></div>' : this.renderMarkdown(content)}
          </div>
          <div class="message-actions">
            <button class="msg-action-btn" onclick="app.copyMessage('${id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy
            </button>
            <button class="msg-action-btn" onclick="app.autoTypeMessage('${id}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>
              Type
            </button>
          </div>
        </div>
      `;
    }

    messages.appendChild(div);
    this.scrollToBottom();
    return id;
  }

  updateMessage(id, content, isFinal = false) {
    const msg = document.getElementById(id);
    if (!msg) return;

    const body = msg.querySelector('.message-body');
    if (body) {
      body.innerHTML = this.renderMarkdown(content);
      // Add copy buttons to code blocks
      if (isFinal) {
        this.addCodeCopyButtons(body);
      }
    }
    this.scrollToBottom();
  }

  addCodeCopyButtons(container) {
    container.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      
      // Detect language from class
      const langClass = code.className.match(/language-(\w+)/);
      const lang = langClass ? langClass[1] : 'code';

      const header = document.createElement('div');
      header.className = 'code-header';
      header.innerHTML = `
        <span>${lang}</span>
        <button class="copy-code-btn" onclick="app.copyCode(this)">Copy</button>
      `;
      pre.insertBefore(header, code);
    });
  }

  copyCode(btn) {
    const pre = btn.closest('pre');
    const code = pre?.querySelector('code');
    if (code) {
      window.haimuai.writeClipboard(code.textContent);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }
  }

  copyMessage(id) {
    const msg = document.getElementById(id);
    const body = msg?.querySelector('.message-body');
    if (body) {
      window.haimuai.writeClipboard(body.textContent);
      this.showToast('Message copied!', 'success');
    }
  }

  autoTypeMessage(id) {
    const msg = document.getElementById(id);
    const body = msg?.querySelector('.message-body');
    if (body) {
      const text = body.textContent;
      const status = window.autoTyper.toggle(text);
      this.updateAutoTypeBtn(status !== 'idle');
    }
  }

  clearChat() {
    const messages = document.getElementById('messages');
    messages.innerHTML = '';
    
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'flex';
    
    window.aiChat.newChat();
    this.lastAIResponse = '';
    this.updateInterviewUI(false);
    this.showToast('Chat cleared', 'info');
  }

  // ========================================
  // New Chat (clears messages + all history)
  // ========================================
  newChatAction() {
    // Clear chat messages from UI
    const messages = document.getElementById('messages');
    messages.innerHTML = '';

    // Show welcome screen
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'flex';

    // Reset AI state
    window.aiChat.newChat();
    window.aiChat.chatSessions = [];
    window.aiChat.saveSessions();

    // Also clear persisted history from localStorage
    localStorage.removeItem('haimuai_sessions');

    this.lastAIResponse = '';
    this.updateInterviewUI(false);

    // Reset active action button
    document.querySelectorAll('.action-btn').forEach(b => b.classList.remove('active'));
    this.currentCommand = 'general';
    const input = document.getElementById('userInput');
    if (input) {
      input.placeholder = this.getPlaceholder('general');
      input.focus();
    }

    this.showToast('✨ New chat started — all history cleared', 'success');
  }

  // ========================================
  // Resume Feature
  // ========================================
  setupResume() {
    const overlay = document.getElementById('resumeOverlay');
    const closeBtn = document.getElementById('btnCloseResume');
    const saveBtn = document.getElementById('btnSaveResume');
    const clearBtn = document.getElementById('btnClearResume');
    const resumeInput = document.getElementById('resumeInput');
    const fileDrop = document.getElementById('resumeFileDrop');
    const fileInput = document.getElementById('resumeFileInput');

    closeBtn?.addEventListener('click', () => this.closePanel('resumeOverlay'));
    overlay?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closePanel('resumeOverlay');
    });

    saveBtn?.addEventListener('click', () => {
      const text = resumeInput?.value.trim();
      if (text) {
        window.aiChat.setResume(text);
        localStorage.setItem('haimuai_resume', text);
        this.updateResumeUI(true);
        this.closePanel('resumeOverlay');
        this.showToast('📄 Resume saved! AI will now answer based on your profile', 'success');
      } else {
        this.showToast('Please paste your resume text first', 'warning');
      }
    });

    clearBtn?.addEventListener('click', () => {
      window.aiChat.clearResume();
      localStorage.removeItem('haimuai_resume');
      if (resumeInput) resumeInput.value = '';
      this.updateResumeUI(false);
      this.showToast('Resume cleared', 'info');
    });

    // File drop
    fileDrop?.addEventListener('click', () => fileInput?.click());
    fileDrop?.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileDrop.classList.add('drag-over');
    });
    fileDrop?.addEventListener('dragleave', () => {
      fileDrop.classList.remove('drag-over');
    });
    fileDrop?.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileDrop.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file) this.handleResumeFile(file, resumeInput);
    });
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.handleResumeFile(file, resumeInput);
      fileInput.value = ''; // Reset so same file can be selected again
    });
  }

  async handleResumeFile(file, targetTextarea) {
    const isImage = file.type.startsWith('image/') || file.name.match(/\.(png|jpg|jpeg|webp|bmp|gif)$/i);
    const isText = file.type.startsWith('text/') || file.name.match(/\.(txt|text|md)$/i);

    if (isImage) {
      // Read as image → show preview → extract text via AI vision
      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target.result;

        // Show image preview in the resume panel
        this.showResumeImagePreview(dataUrl, file.name);
        this.showToast('🔄 Extracting text from resume image...', 'info');

        try {
          // Use AI vision to extract resume text
          const extractedText = await window.aiChat.analyzeScreenshot(
            dataUrl,
            'Extract ALL text content from this resume/CV image. Return ONLY the extracted text in a clean, structured format. Include: name, contact details, skills, experience, education, projects, certifications, and any other sections visible. Be thorough and accurate.',
            'text',
            false // Don't sync resume extraction with chat history
          );

          if (targetTextarea) {
            targetTextarea.value = extractedText;
          }

          // Auto-save the extracted text
          window.aiChat.setResume(extractedText);
          localStorage.setItem('haimuai_resume', extractedText);
          // Also save the image for display
          localStorage.setItem('haimuai_resume_image', dataUrl);
          this.updateResumeUI(true);
          this.showToast('📄 Resume extracted from image and saved!', 'success');
        } catch (error) {
          this.showToast('❌ Failed to extract text: ' + error.message, 'error');
          console.error('Resume extraction error:', error);
        }
      };
      reader.readAsDataURL(file);

    } else if (isText) {
      // Plain text files
      const reader = new FileReader();
      reader.onload = (e) => {
        if (targetTextarea) {
          targetTextarea.value = e.target.result;
        }
        this.showToast(`File "${file.name}" loaded`, 'success');
      };
      reader.readAsText(file);

    } else {
      // PDF or other unsupported — guide user
      this.showToast('⚠️ PDFs show as garbled text. Please upload an image (screenshot) of your resume instead.', 'warning');
    }
  }

  showResumeImagePreview(dataUrl, fileName) {
    let preview = document.getElementById('resumeImagePreview');
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'resumeImagePreview';
      preview.className = 'resume-image-preview';
      const fileDrop = document.getElementById('resumeFileDrop');
      fileDrop?.parentNode?.insertBefore(preview, fileDrop.nextSibling);
    }
    preview.innerHTML = `
      <div class="resume-preview-header">
        <span>📸 ${fileName || 'Resume Image'}</span>
        <button class="resume-preview-remove" onclick="app.removeResumePreview()">✕</button>
      </div>
      <img src="${dataUrl}" alt="Resume Preview">
    `;
    preview.style.display = 'block';
  }

  removeResumePreview() {
    const preview = document.getElementById('resumeImagePreview');
    if (preview) preview.style.display = 'none';
    localStorage.removeItem('haimuai_resume_image');
  }

  updateResumeUI(loaded) {
    const btn = document.getElementById('btnResumeToggle');
    const status = document.getElementById('resumeStatus');
    const statusText = document.getElementById('resumeStatusText');
    const interviewNote = document.getElementById('interviewResumeNote');
    const interviewStatus = document.getElementById('interviewResumeStatus');

    if (loaded) {
      btn?.classList.add('has-resume');
      status?.classList.add('loaded');
      if (statusText) statusText.textContent = '✅ Resume loaded and active';
      interviewNote?.classList.add('loaded');
      if (interviewStatus) interviewStatus.textContent = '✅ Resume loaded - questions will be personalized!';
    } else {
      btn?.classList.remove('has-resume');
      status?.classList.remove('loaded');
      if (statusText) statusText.textContent = 'No resume loaded';
      interviewNote?.classList.remove('loaded');
      if (interviewStatus) interviewStatus.textContent = 'No resume loaded - questions will be generic';
    }
  }

  openResumePanel() {
    const resumeInput = document.getElementById('resumeInput');
    const savedResume = window.aiChat.getResume();
    if (savedResume && resumeInput) {
      resumeInput.value = savedResume;
    }
    this.openPanel('resumeOverlay');
  }

  // ========================================
  // Interview Mode
  // ========================================
  setupInterview() {
    const overlay = document.getElementById('interviewOverlay');
    const closeBtn = document.getElementById('btnCloseInterview');
    const startBtn = document.getElementById('btnStartInterview');
    const startOnlineBtn = document.getElementById('btnStartOnlineInterview');
    const stopBtn = document.getElementById('btnStopInterview');
    const topicInput = document.getElementById('interviewTopic');

    // Mode selector tabs
    let selectedMode = 'practice';
    document.querySelectorAll('.interview-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.interview-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = btn.dataset.mode;

        const practiceContent = document.getElementById('practiceContent');
        const onlineContent = document.getElementById('onlineContent');
        const startPractice = document.getElementById('btnStartInterview');
        const startOnline = document.getElementById('btnStartOnlineInterview');

        if (selectedMode === 'online') {
          practiceContent.style.display = 'none';
          onlineContent.style.display = 'block';
          startPractice.style.display = 'none';
          startOnline.style.display = 'block';
        } else {
          practiceContent.style.display = 'block';
          onlineContent.style.display = 'none';
          startPractice.style.display = 'block';
          startOnline.style.display = 'none';
        }
      });
    });

    closeBtn?.addEventListener('click', () => this.closePanel('interviewOverlay'));
    overlay?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closePanel('interviewOverlay');
    });

    // Quick topic chips
    document.querySelectorAll('.topic-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        if (topicInput) topicInput.value = chip.dataset.topic;
      });
    });

    startBtn?.addEventListener('click', () => {
      const topic = topicInput?.value.trim() || '';
      this.startInterview(topic);
    });

    startOnlineBtn?.addEventListener('click', () => {
      const topic = topicInput?.value.trim() || '';
      this.startOnlineInterview(topic);
    });

    stopBtn?.addEventListener('click', () => {
      if (window.aiChat.isOnlineInterviewActive()) {
        this.stopOnlineInterview();
      } else {
        this.stopInterview();
      }
    });
  }

  // ========================================
  // Interview PDF Upload
  // ========================================
  setupInterviewPdf() {
    const dropZone = document.getElementById('interviewPdfDrop');
    const fileInput = document.getElementById('interviewPdfInput');
    const statusEl = document.getElementById('interviewPdfStatus');
    const removeBtn = document.getElementById('btnRemoveInterviewPdf');

    // Click to open file picker
    dropZone?.addEventListener('click', () => fileInput?.click());

    // Drag events
    dropZone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
    dropZone?.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone?.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files[0];
      if (file) this._handleInterviewPdfFile(file);
    });

    // File input change
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this._handleInterviewPdfFile(file);
      fileInput.value = '';
    });

    // Remove button
    removeBtn?.addEventListener('click', () => {
      this.interviewPdfText = '';
      if (statusEl) statusEl.style.display = 'none';
      const dropEl = document.getElementById('interviewPdfDrop');
      if (dropEl) dropEl.style.display = 'flex';
      this.showToast('Document removed', 'info');
    });
  }

  async _handleInterviewPdfFile(file) {
    const isImage = file.type.startsWith('image/') || file.name.match(/\.(png|jpg|jpeg|webp|bmp|gif)$/i);
    const isText = file.type.startsWith('text/') || file.name.match(/\.(txt|text|md)$/i);
    const isPdf = file.type === 'application/pdf' || file.name.match(/\.pdf$/i);

    const dropZone = document.getElementById('interviewPdfDrop');
    const statusEl = document.getElementById('interviewPdfStatus');
    const nameEl = document.getElementById('interviewPdfName');
    const badgeEl = document.getElementById('interviewPdfBadge');

    if (isPdf) {
      // PDFs can't be read as text in the browser — guide user to screenshot it
      this.showToast('⚠️ PDFs cannot be read directly. Please take a screenshot of the JD/question paper and upload the image instead.', 'warning');
      return;
    }

    if (isImage) {
      // Show processing state
      dropZone?.classList.add('processing');
      if (badgeEl) { badgeEl.textContent = 'Extracting...'; badgeEl.className = 'interview-pdf-badge extracting'; }
      if (nameEl) nameEl.textContent = file.name;
      if (statusEl) statusEl.style.display = 'flex';
      if (dropZone) dropZone.style.display = 'none';
      this.showToast('🔄 Extracting text from document...', 'info');

      const reader = new FileReader();
      reader.onload = async (e) => {
        const dataUrl = e.target.result;
        try {
          const extractedText = await window.aiChat.analyzeScreenshot(
            dataUrl,
            'Extract ALL text content from this document/image. This is likely a job description, question paper, or study material. Return ONLY the raw extracted text in a clean, structured format. Be thorough — include every section, requirement, question, and detail visible.',
            'text',
            false // Don't add to chat history
          );

          this.interviewPdfText = extractedText;
          if (badgeEl) { badgeEl.textContent = 'Extracted'; badgeEl.className = 'interview-pdf-badge'; }
          dropZone?.classList.remove('processing');
          this.showToast('📄 Document extracted! Interview questions will be based on this.', 'success');
        } catch (error) {
          this.interviewPdfText = '';
          if (statusEl) statusEl.style.display = 'none';
          if (dropZone) { dropZone.style.display = 'flex'; dropZone.classList.remove('processing'); }
          this.showToast('❌ Failed to extract: ' + error.message, 'error');
          console.error('Interview PDF extraction error:', error);
        }
      };
      reader.readAsDataURL(file);

    } else if (isText) {
      const reader = new FileReader();
      reader.onload = (e) => {
        this.interviewPdfText = e.target.result;
        if (nameEl) nameEl.textContent = file.name;
        if (badgeEl) { badgeEl.textContent = 'Loaded'; badgeEl.className = 'interview-pdf-badge'; }
        if (statusEl) statusEl.style.display = 'flex';
        if (dropZone) dropZone.style.display = 'none';
        this.showToast(`📄 "${file.name}" loaded — interview will use this context`, 'success');
      };
      reader.readAsText(file);

    } else {
      this.showToast('⚠️ Unsupported file type. Upload an image (screenshot of PDF) or .txt file.', 'warning');
    }
  }

  async startInterview(topic) {
    this.closePanel('interviewOverlay');

    // Clear current chat
    const messages = document.getElementById('messages');
    messages.innerHTML = '';
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'none';

    // Pass uploaded document context to AI
    window.aiChat.setInterviewDocument(this.interviewPdfText);

    // Start interview mode in AI
    window.aiChat.startInterview(topic);
    this.updateInterviewUI(true, topic);

    // Auto-send first message to get the first question
    const input = document.getElementById('userInput');
    if (input) input.placeholder = 'Type your answer... (Enter to send)';

    const docNote = this.interviewPdfText ? ' I have uploaded a document (JD/question paper) — base your questions on it.' : '';
    const startMsg = `Start the interview${topic ? ' on ' + topic : ''}.${docNote} Ask me the first question.`;

    this.addMessage('user', startMsg);
    const aiMsgId = this.addMessage('ai', null, true);

    try {
      const language = document.getElementById('languageSelect')?.value || 'javascript';
      let fullResponse = '';
      await window.aiChat.sendMessage(
        startMsg,
        'general',
        language,
        (chunk, fullText) => {
          fullResponse = fullText;
          this.updateMessage(aiMsgId, fullText);
        }
      );
      this.lastAIResponse = fullResponse;
      this.updateMessage(aiMsgId, fullResponse, true);
    } catch (error) {
      this.updateMessage(aiMsgId, `❌ **Error:** ${error.message}`, true);
    }
  }

  stopInterview() {
    window.aiChat.stopInterview();
    this.updateInterviewUI(false);
    const input = document.getElementById('userInput');
    if (input) input.placeholder = this.getPlaceholder('general');
    this.showToast('🎯 Interview ended', 'info');
  }

  updateInterviewUI(active, topic = '', isOnline = false) {
    const banner = document.getElementById('interviewBanner');
    const bannerText = document.getElementById('interviewBannerText');
    const interviewBtn = document.getElementById('btnInterviewToggle');

    if (active) {
      banner?.classList.add('active');
      if (isOnline) {
        if (bannerText) bannerText.textContent = `🔴 Online Interview: ${topic || 'General'}`;
        banner?.classList.add('online');
      } else {
        if (bannerText) bannerText.textContent = `🎯 Interview: ${topic || 'General'}`;
        banner?.classList.remove('online');
      }
      interviewBtn?.classList.add('active');
    } else {
      banner?.classList.remove('active');
      banner?.classList.remove('online');
      interviewBtn?.classList.remove('active');
    }
  }

  // ========================================
  // Online Interview Mode
  // ========================================
  async startOnlineInterview(topic) {
    this.closePanel('interviewOverlay');

    // Clear current chat
    const messages = document.getElementById('messages');
    messages.innerHTML = '';
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'none';

    // Pass uploaded document context to AI
    window.aiChat.setInterviewDocument(this.interviewPdfText);

    // Start online interview mode in AI
    window.aiChat.startOnlineInterview(topic);
    this.updateInterviewUI(true, topic, true);

    const input = document.getElementById('userInput');
    if (input) input.placeholder = 'Type a question or press Ctrl+4 to capture screen...';

    // Show a system message
    this.addMessage('ai', null, false);
    const aiMsgId = `msg-${this.messageCount}`;
    this.updateMessage(aiMsgId, `🔴 **Online Interview Assist Active**\n\nI'm ready to help you answer interview questions.\n\n- Press **Ctrl+4** to capture a question from your screen\n- Or **type the question** and I'll frame a perfect answer\n- Answers are in **first-person**, ready for you to speak\n\n_Topic: ${topic || 'General'}_`, true);
  }

  stopOnlineInterview() {
    window.aiChat.stopOnlineInterview();
    this.updateInterviewUI(false);
    const input = document.getElementById('userInput');
    if (input) input.placeholder = this.getPlaceholder('general');
    this.showToast('🔴 Online Interview Assist ended', 'info');
  }

  // ========================================
  // Chat History
  // ========================================
  setupHistory() {
    const overlay = document.getElementById('historyOverlay');
    const closeBtn = document.getElementById('btnCloseHistory');
    const newChatBtn = document.getElementById('btnNewChat');

    closeBtn?.addEventListener('click', () => this.closePanel('historyOverlay'));
    overlay?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.closePanel('historyOverlay');
    });

    newChatBtn?.addEventListener('click', () => {
      this.clearChat();
      this.closePanel('historyOverlay');
    });
  }

  openHistoryPanel() {
    this.renderHistoryList();
    this.openPanel('historyOverlay');
  }

  renderHistoryList() {
    const list = document.getElementById('historyList');
    if (!list) return;

    const sessions = window.aiChat.getSessions();
    if (sessions.length === 0) {
      list.innerHTML = `
        <div class="history-empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <p>No chat history yet</p>
        </div>
      `;
      return;
    }

    list.innerHTML = [...sessions].reverse().map(session => {
      const date = new Date(session.timestamp);
      const timeStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const icon = session.mode === 'interview' ? '🎯' : '💬';
      const msgCount = session.history.length;
      const isActive = session.id === window.aiChat.currentSessionId;

      return `
        <div class="history-item ${isActive ? 'active' : ''}" data-session-id="${session.id}">
          <span class="history-item-icon">${icon}</span>
          <div class="history-item-content">
            <div class="history-item-title">${this.escapeHtml(session.title)}</div>
            <div class="history-item-meta">${timeStr} · ${msgCount} messages</div>
          </div>
          <button class="history-item-delete" data-delete-id="${session.id}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      `;
    }).join('');

    // Add click handlers
    list.querySelectorAll('.history-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.history-item-delete')) return;
        const sessionId = item.dataset.sessionId;
        this.loadSession(sessionId);
      });
    });

    list.querySelectorAll('.history-item-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sessionId = btn.dataset.deleteId;
        window.aiChat.deleteSession(sessionId);
        this.renderHistoryList();
        this.showToast('Session deleted', 'info');
      });
    });
  }

  loadSession(sessionId) {
    const session = window.aiChat.loadSession(sessionId);
    if (!session) return;

    // Rebuild chat UI from history
    const messages = document.getElementById('messages');
    messages.innerHTML = '';
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'none';

    session.history.forEach(msg => {
      if (msg.role === 'user') {
        this.addMessage('user', msg.content);
      } else if (msg.role === 'assistant') {
        const id = this.addMessage('ai', null, false);
        this.updateMessage(id, msg.content, true);
      }
    });

    // Update interview state
    if (session.mode === 'interview') {
      this.updateInterviewUI(true, session.topic || '', false);
      const input = document.getElementById('userInput');
      if (input) input.placeholder = 'Type your answer... (Enter to send)';
    } else if (session.mode === 'online-interview') {
      this.updateInterviewUI(true, session.topic || '', true);
      const input = document.getElementById('userInput');
      if (input) input.placeholder = 'Type a question or press Ctrl+4 to capture screen...';
    } else {
      this.updateInterviewUI(false);
    }

    this.closePanel('historyOverlay');
    this.showToast('Session loaded', 'success');
  }

  // ========================================
  // Panel Helpers
  // ========================================
  openPanel(id) {
    document.getElementById(id)?.classList.add('active');
  }

  closePanel(id) {
    document.getElementById(id)?.classList.remove('active');
  }

  scrollToBottom() {
    const chatArea = document.getElementById('chatArea');
    requestAnimationFrame(() => {
      chatArea.scrollTop = chatArea.scrollHeight;
    });
  }

  // ========================================
  // Markdown Rendering
  // ========================================
  renderMarkdown(text) {
    if (!text) return '';
    
    // Simple markdown renderer
    let html = text;
    
    // Escape HTML first
    html = html
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Code blocks (``` ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.+<\/li>\n?)+/g, '<ul>$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Links
    html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Line breaks -> paragraphs
    html = html.replace(/\n\n/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    
    // Wrap in paragraph if not already wrapped
    if (!html.startsWith('<')) {
      html = '<p>' + html + '</p>';
    }

    return html;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ========================================
  // Screenshot (Multi-Capture)
  // ========================================
  setupScreenshot() {
    // ---- Analyze all collected screenshots ----
    document.getElementById('btnAnalyzeScreenshot')?.addEventListener('click', async () => {
      const shots = window.screenshotManager.getAllScreenshots();
      if (shots.length === 0) {
        this.showToast('No screenshots to analyze', 'warning');
        return;
      }

      const promptInput = document.getElementById('screenshotPrompt');
      const userPrompt = promptInput?.value.trim();
      const question = userPrompt || 'What do you see in these screenshots? Describe and help the user.';

      window.screenshotManager.hidePreview();
      if (promptInput) promptInput.value = '';

      const welcome = document.getElementById('welcomeScreen');
      if (welcome) welcome.style.display = 'none';

      const n = shots.length;
      const displayMsg = userPrompt
        ? `📸 [${n} screenshot${n > 1 ? 's' : ''} captured]\n\n**Prompt:** ${userPrompt}`
        : `📸 [${n} screenshot${n > 1 ? 's' : ''} captured — Analyzing...]`;
      this.addMessage('user', displayMsg);
      const aiMsgId = this.addMessage('ai', null, true);

      try {
        const language = document.getElementById('languageSelect')?.value || 'javascript';
        const images = shots.map(s => s.dataUrl);
        const response = await window.aiChat.analyzeScreenshots(images, question, language, true);
        this.lastAIResponse = response;
        this.updateMessage(aiMsgId, response, true);
      } catch (error) {
        this.updateMessage(aiMsgId, `❌ **Error:** ${error.message}`, true);
      }

      // Clear screenshots after upload
      window.screenshotManager.clearScreenshots();
    });

    // ---- Close buttons ----
    const closeHandler = () => {
      window.screenshotManager.hidePreview();
      const promptInput = document.getElementById('screenshotPrompt');
      if (promptInput) promptInput.value = '';
    };
    document.getElementById('btnCloseScreenshot')?.addEventListener('click', closeHandler);
    document.getElementById('btnCloseScreenshotBottom')?.addEventListener('click', closeHandler);

    // ---- Add another capture (while modal is open) ----
    document.getElementById('btnAddCapture')?.addEventListener('click', async () => {
      // Hide modal first so our window doesn't appear in screenshot
      window.screenshotManager.hidePreview();
      await new Promise(r => setTimeout(r, 150));
      try {
        const dataUrl = await window.screenshotManager.capture();
        if (dataUrl) {
          window.screenshotManager.addScreenshot(dataUrl, 'capture');
          window.screenshotManager.showPreview(); // showPreview calls _renderGallery internally
          this._updateAnalyzeLabel();
          this.showToast(`📸 Screenshot ${window.screenshotManager.screenshots.length} added!`, 'success');
        }
      } catch (err) {
        this.showToast('Capture failed: ' + err.message, 'error');
        window.screenshotManager.showPreview(); // re-show on error
      }
    });

    // ---- Upload from file ----
    document.getElementById('btnUploadScreenshot')?.addEventListener('click', () => {
      document.getElementById('ssFileInput')?.click();
    });
    document.getElementById('ssFileInput')?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      files.forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          window.screenshotManager.addScreenshot(ev.target.result, 'upload');
          window.screenshotManager._renderGallery();
          this._updateAnalyzeLabel();
          this.showToast(`🖼️ "${file.name}" added`, 'success');
        };
        reader.readAsDataURL(file);
      });
      e.target.value = ''; // reset so same file can be re-selected
    });

    // ---- Clear all ----
    document.getElementById('btnClearScreenshots')?.addEventListener('click', () => {
      window.screenshotManager.clearScreenshots();
      window.screenshotManager._renderGallery();
      this._updateAnalyzeLabel();
      this.showToast('All screenshots cleared', 'info');
    });

    // ---- Opacity slider ----
    const opacitySlider = document.getElementById('screenshotOpacity');
    const opacityValue = document.getElementById('screenshotOpacityValue');
    opacitySlider?.addEventListener('input', (e) => {
      const val = e.target.value;
      if (opacityValue) opacityValue.textContent = val + '%';
      const modal = document.getElementById('screenshotModal');
      if (modal) modal.style.setProperty('--screenshot-overlay-opacity', val / 100);
    });

    // ---- Ctrl+Enter to analyze ----
    document.getElementById('screenshotPrompt')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        document.getElementById('btnAnalyzeScreenshot')?.click();
      }
    });
  }

  _updateAnalyzeLabel() {
    const n = window.screenshotManager.getAllScreenshots().length;
    const label = document.getElementById('btnAnalyzeLabel');
    if (label) {
      label.textContent = n > 1 ? `Analyze All ${n} Screenshots` : 'Analyze with AI';
    }
    // Show/hide empty state
    const empty = document.getElementById('ssGalleryEmpty');
    const gallery = document.getElementById('screenshotGallery');
    if (empty) empty.style.display = n === 0 ? 'flex' : 'none';
    if (gallery) gallery.style.display = n === 0 ? 'none' : 'flex';
  }

  async handleScreenshot() {
    try {
      const dataUrl = await window.screenshotManager.capture();
      if (dataUrl) {
        // Add to pending attachments in input area (ChatGPT style)
        this.addAttachment(dataUrl, 'capture');
        this.showToast('📸 Screenshot added! Type a message and send.', 'success');

        // Pre-fill prompt if in online interview mode
        if (window.aiChat.isOnlineInterviewActive()) {
          const input = document.getElementById('userInput');
          if (input && !input.value.trim()) {
            input.value = 'Answer this interview question for me';
            input.dispatchEvent(new Event('input'));
          }
        }

        // Note: Do not auto-focus input here to prevent stealing OS focus from exam browsers
      }
    } catch (error) {
      this.showToast('Screenshot failed: ' + error.message, 'error');
    }
  }

  // ========================================
  // Attachment System (clipboard-style)
  // ========================================
  setupAttachments() {
    // "+" upload button in input area
    document.getElementById('btnAttachFile')?.addEventListener('click', () => {
      document.getElementById('attachFileInput')?.click();
    });

    document.getElementById('attachFileInput')?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      files.forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          this.addAttachment(ev.target.result, 'upload');
          this.showToast(`🖼️ "${file.name}" attached`, 'success');
        };
        reader.readAsDataURL(file);
      });
      e.target.value = '';
    });
  }

  addAttachment(dataUrl, source = 'capture') {
    const id = this._attachNextId++;
    this.pendingAttachments.push({ id, dataUrl, source });
    this.renderAttachmentsStrip();
    return id;
  }

  removeAttachment(id) {
    this.pendingAttachments = this.pendingAttachments.filter(a => a.id !== id);
    this.renderAttachmentsStrip();
  }

  renderAttachmentsStrip() {
    const strip = document.getElementById('attachmentsStrip');
    if (!strip) return;

    const n = this.pendingAttachments.length;
    strip.style.display = n > 0 ? 'flex' : 'none';

    strip.innerHTML = this.pendingAttachments.map(a => `
      <div class="attach-chip" data-id="${a.id}">
        <img src="${a.dataUrl}" class="attach-chip-thumb" alt="screenshot">
        <button class="attach-chip-remove" onclick="app.removeAttachment(${a.id})">✕</button>
      </div>
    `).join('');

    // Update send button / placeholder hint
    const input = document.getElementById('userInput');
    if (input) {
      input.placeholder = n > 0
        ? `Add a message (optional) and press Enter to analyze ${n} image${n > 1 ? 's' : ''}...`
        : this.getPlaceholder(this.currentCommand);
    }
  }



  // ========================================
  // Answer Question (auto-capture + instant AI answer)
  // ========================================
  async handleAnswerQuestion() {
    const answerBtn = document.getElementById('btnAnswerQuestion');
    answerBtn?.classList.add('processing');
    this.showToast('📸 Capturing screen to answer...', 'info');

    try {
      // Step 1: Auto-capture screenshot (skip preview modal)
      const dataUrl = await window.screenshotManager.capture();
      if (!dataUrl) {
        throw new Error('No screenshot data received');
      }

      // Step 2: Hide welcome, show chat
      const welcome = document.getElementById('welcomeScreen');
      if (welcome) welcome.style.display = 'none';

      // Step 3: Add user message
      this.addMessage('user', '📸 [Auto-captured screen] — Answer the question shown');
      const aiMsgId = this.addMessage('ai', null, true);

      // Step 4: Send to AI with specialized answer prompt
      const language = document.getElementById('languageSelect')?.value || 'javascript';
      const answerPrompt = 'Look at this screenshot carefully. Find ANY question visible — it could be a coding problem, MCQ, fill-in-the-blank, true/false, short answer, or interview question. Answer it completely and correctly. For MCQs: state the correct option with a brief explanation. For coding: provide the full working solution. For theory: give a clear, concise answer.';

      const response = await window.aiChat.analyzeScreenshot(dataUrl, answerPrompt, language, true);
      this.lastAIResponse = response;
      this.updateMessage(aiMsgId, response, true);

      this.showToast('✅ Question answered!', 'success');
    } catch (error) {
      this.showToast('❌ ' + error.message, 'error');
      console.error('Answer question error:', error);
    } finally {
      answerBtn?.classList.remove('processing');
    }
  }

  // Processes a screenshot sent from main process (keyhook Right-Alt+A)
  async processAnswerScreenshot(dataUrl) {
    const answerBtn = document.getElementById('btnAnswerQuestion');
    answerBtn?.classList.add('processing');
    this.showToast('🧠 Analyzing screenshot...', 'info');

    try {
      const welcome = document.getElementById('welcomeScreen');
      if (welcome) welcome.style.display = 'none';

      this.addMessage('user', '📸 [Auto-captured screen] — Answer the question shown');
      const aiMsgId = this.addMessage('ai', null, true);

      const language = document.getElementById('languageSelect')?.value || 'javascript';
      const answerPrompt = 'Look at this screenshot carefully. Find ANY question visible — it could be a coding problem, MCQ, fill-in-the-blank, true/false, short answer, or interview question. Answer it completely and correctly. For MCQs: state the correct option with a brief explanation. For coding: provide the full working solution. For theory: give a clear, concise answer.';

      const response = await window.aiChat.analyzeScreenshot(dataUrl, answerPrompt, language, true);
      this.lastAIResponse = response;
      this.updateMessage(aiMsgId, response, true);

      this.showToast('✅ Question answered!', 'success');
    } catch (error) {
      this.showToast('❌ ' + error.message, 'error');
      console.error('Answer question error:', error);
    } finally {
      answerBtn?.classList.remove('processing');
    }
  }

  updateScreenshotSyncIndicator() {
    const syncText = document.getElementById('screenshotSyncText');
    const syncEl = document.getElementById('screenshotChatSync');
    const historyLen = window.aiChat.conversationHistory.length;
    
    if (historyLen > 0) {
      const msgCount = Math.floor(historyLen / 2);
      if (syncText) syncText.textContent = `🔗 Synced with current chat (${msgCount} exchange${msgCount !== 1 ? 's' : ''}) — AI will answer in context`;
      syncEl?.classList.add('synced');
    } else {
      if (syncText) syncText.textContent = '💬 New conversation — no previous context';
      syncEl?.classList.remove('synced');
    }
  }

  // ========================================
  // Voice
  // ========================================
  setupVoice() {
    const voiceBtn = document.getElementById('btnVoice');
    const voiceIndicator = document.getElementById('voiceIndicator');
    const input = document.getElementById('userInput');
    let savedPlaceholder = '';
    let recordingTimer = null;

    // Create waveform container (injected near input area)
    this._createWaveformUI();

    // Transcription result → update input field
    window.voiceRecorder.setOnResult((transcript, isFinal) => {
      if (input && transcript) {
        input.value = transcript;
        input.dispatchEvent(new Event('input'));
        input.selectionStart = input.selectionEnd = input.value.length;
        input.focus();
      }
    });

    window.voiceRecorder.setOnEnd((transcript) => {
      voiceBtn?.classList.remove('recording');
      voiceIndicator?.classList.remove('recording');
      if (input) {
        input.placeholder = savedPlaceholder || this.getPlaceholder(this.currentCommand);
        input.classList.remove('voice-active');
      }
      this._hideWaveform();
      this._stopRecordingTimer();
    });

    // Waveform data callback
    window.voiceRecorder.setOnWaveformUpdate((bars) => {
      this._updateWaveformBars(bars);
    });

    // Status change callback for visual feedback
    window.voiceRecorder.setOnStatusChange((status) => {
      if (status === 'recording') {
        voiceBtn?.classList.add('recording');
        voiceIndicator?.classList.add('recording');
        if (input) {
          savedPlaceholder = input.placeholder;
          input.placeholder = '🎤 Listening... (stops on silence or click mic)';
          input.classList.add('voice-active');
          input.focus();
        }
        this._showWaveform();
        this._startRecordingTimer();
      } else if (status === 'transcribing') {
        voiceBtn?.classList.remove('recording');
        voiceIndicator?.classList.remove('recording');
        if (input) {
          input.placeholder = '🔄 Transcribing your audio...';
          input.classList.add('voice-active');
        }
        this._hideWaveform();
        this._stopRecordingTimer();
      } else {
        voiceBtn?.classList.remove('recording');
        voiceIndicator?.classList.remove('recording');
        if (input) {
          input.placeholder = savedPlaceholder || this.getPlaceholder(this.currentCommand);
          input.classList.remove('voice-active');
        }
        this._hideWaveform();
        this._stopRecordingTimer();
      }
    });

    voiceBtn?.addEventListener('click', () => {
      this.toggleVoice();
    });

    voiceIndicator?.addEventListener('click', () => {
      this.toggleVoice();
    });
  }

  toggleVoice() {
    if (window.voiceRecorder.isRecording) {
      window.voiceRecorder.stop();
      this.showToast('🎤 Stopped — transcribing with AI...', 'info');
    } else {
      window.voiceRecorder.start();
    }
  }

  _createWaveformUI() {
    // Create waveform visualizer container
    const inputArea = document.getElementById('inputArea');
    if (!inputArea) return;

    const waveform = document.createElement('div');
    waveform.id = 'voiceWaveform';
    waveform.className = 'voice-waveform';
    waveform.innerHTML = `
      <div class="waveform-header">
        <div class="waveform-recording-dot"></div>
        <span class="waveform-label">Recording</span>
        <span class="waveform-timer" id="waveformTimer">0:00</span>
      </div>
      <div class="waveform-bars" id="waveformBars">
        ${Array.from({ length: 32 }, (_, i) => `<div class="waveform-bar" data-index="${i}"></div>`).join('')}
      </div>
      <div class="waveform-hint">Stops automatically on silence • Click mic to stop manually</div>
    `;
    inputArea.insertBefore(waveform, inputArea.firstChild);
  }

  _showWaveform() {
    const el = document.getElementById('voiceWaveform');
    if (el) el.classList.add('active');
  }

  _hideWaveform() {
    const el = document.getElementById('voiceWaveform');
    if (el) el.classList.remove('active');
  }

  _updateWaveformBars(data) {
    const bars = document.querySelectorAll('#waveformBars .waveform-bar');
    bars.forEach((bar, i) => {
      const value = data[i] || 0;
      const height = Math.max(3, value * 40);
      bar.style.height = `${height}px`;
      // Color intensity based on level
      const intensity = Math.round(100 + value * 155);
      bar.style.backgroundColor = `rgba(124, 58, 237, ${0.3 + value * 0.7})`;
    });
  }

  _startRecordingTimer() {
    const timerEl = document.getElementById('waveformTimer');
    if (!timerEl) return;

    const startTime = Date.now();
    this._recordingTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
  }

  _stopRecordingTimer() {
    if (this._recordingTimerInterval) {
      clearInterval(this._recordingTimerInterval);
      this._recordingTimerInterval = null;
    }
    const timerEl = document.getElementById('waveformTimer');
    if (timerEl) timerEl.textContent = '0:00';
  }

  // ========================================
  // Settings
  // ========================================
  setupSettings() {
    // Open settings via gear button in title bar
    document.getElementById('btnSettings')?.addEventListener('click', () => {
      window.settingsManager.toggle();
    });

    // Wire up provider toggle + Ollama model chips + Test button
    window.settingsManager.bindProviderUI();

    document.getElementById('btnCloseSettings')?.addEventListener('click', () => {
      window.settingsManager.close();
    });

    document.getElementById('settingsOverlay')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        window.settingsManager.close();
      }
    });

    document.getElementById('btnSaveSettings')?.addEventListener('click', async () => {
      const settings = window.settingsManager.collectFromUI();
      const [settingsOk, freeModeOk] = await Promise.all([
        window.settingsManager.save(settings),
        window.settingsManager.saveFreeModeSettings(),
      ]);
      if (settingsOk) {
        const fmEnabled = document.getElementById('settingFreeModeEnabled')?.checked;
        const keyCount = window.settingsManager._freeApiKeys.length;
        if (fmEnabled && keyCount > 0) {
          this.showToast(`✅ Settings saved! Free Mode active with ${keyCount} key${keyCount > 1 ? 's' : ''}.`, 'success');
        } else {
          this.showToast('Settings saved!', 'success');
        }
        window.settingsManager.close();
      } else {
        this.showToast('Failed to save settings', 'error');
      }
    });

    // Always Active checkbox — toggle immediately via IPC (no need to wait for Save)
    document.getElementById('settingAlwaysActive')?.addEventListener('change', async (e) => {
      const current = await window.haimuai.getAlwaysActive();
      // Only toggle if state actually differs from checkbox
      if (current !== e.target.checked) {
        const alwaysActive = await window.haimuai.toggleAlwaysActive();
        this.updateAlwaysActiveUI(alwaysActive);
        this.showToast(
          alwaysActive
            ? '\ud83d\udd12 Always Active ON — interactions won\'t trigger window switch'
            : '\ud83d\udd13 Always Active OFF — normal focus behavior',
          'info'
        );
      }
    });

    // Theme toggle buttons
    document.querySelectorAll('.toggle-btn[data-theme]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.toggle-btn[data-theme]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.documentElement.setAttribute('data-theme', btn.dataset.theme);
      });
    });

    // Range inputs - live preview
    document.getElementById('settingOpacity')?.addEventListener('input', (e) => {
      document.getElementById('opacityValue').textContent = e.target.value + '%';
    });
    document.getElementById('settingFontSize')?.addEventListener('input', (e) => {
      document.getElementById('fontSizeValue').textContent = e.target.value + 'px';
      document.documentElement.style.setProperty('--font-size-base', e.target.value + 'px');
    });
    document.getElementById('settingTypingSpeed')?.addEventListener('input', (e) => {
      document.getElementById('typingSpeedValue').textContent = e.target.value + 'ms';
    });

    // API key link
    document.getElementById('linkApiKey')?.addEventListener('click', (e) => {
      e.preventDefault();
      // Can't use shell.openExternal from renderer, so just show the URL
      this.showToast('Visit: console.groq.com/keys', 'info');
    });
  }

  // ========================================
  // Drag & Drop
  // ========================================
  setupDragDrop() {
    const body = document.body;

    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    body.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        const reader = new FileReader();
        reader.onload = (event) => {
          const input = document.getElementById('userInput');
          if (input && event.target.result) {
            if (file.type.startsWith('text/') || file.name.match(/\.(js|py|java|cpp|c|cs|ts|html|css|json|md|txt|yml|yaml|xml|sh|bat|ps1|rb|go|rs|php|sql)$/i)) {
              input.value += event.target.result;
              input.dispatchEvent(new Event('input'));
              this.showToast(`File "${file.name}" loaded`, 'success');
            } else {
              this.showToast('Unsupported file type', 'error');
            }
          }
        };
        reader.readAsText(file);
      }

      // Handle dropped text
      const text = e.dataTransfer?.getData('text/plain');
      if (text) {
        const input = document.getElementById('userInput');
        if (input) {
          input.value += text;
          input.dispatchEvent(new Event('input'));
        }
      }
    });
  }

  // ========================================
  // IPC Events (from main process)
  // ========================================
  setupIPC() {
    window.haimuai.onSafeModeChanged((active) => {
      this.updateSafeModeUI(active);
    });

    window.haimuai.onInteractionSafeModeChanged((active) => {
    });

    window.haimuai.onGhostModeChanged((active) => {
      this.updateGhostModeUI(active);
    });

    window.haimuai.onAlwaysActiveChanged((active) => {
      this.updateAlwaysActiveUI(active);
    });

    window.haimuai.onScreenshotTaken((dataUrl) => {
      this.addAttachment(dataUrl, 'capture');
      this.showToast('📸 Screenshot added to input! Type a message and send.', 'success');
      // Note: Do not auto-focus input here to prevent stealing OS focus from exam browsers
    });

    window.haimuai.onAiCommand((command) => {
      document.querySelectorAll('.action-btn').forEach(b => b.classList.remove('active'));
      const btn = document.querySelector(`.action-btn[data-command="${command}"]`);
      btn?.classList.add('active');
      this.currentCommand = command;
      
      const input = document.getElementById('userInput');
      if (input) {
        input.placeholder = this.getPlaceholder(command);
        window.haimuai?.getAlwaysActive?.().then(active => {
          if (!active) input.focus();
        });
      }
      
      this.showToast(`Mode: ${command.charAt(0).toUpperCase() + command.slice(1)}`, 'info');
    });

    window.haimuai.onToggleVoice(() => {
      this.toggleVoice();
    });

    window.haimuai.onToggleAutoType(() => {
      if (this.lastAIResponse) {
        const status = window.autoTyper.toggle(this.lastAIResponse);
        this.updateAutoTypeBtn(status !== 'idle');
      }
    });

    window.haimuai.onOpenSettings(() => {
      window.settingsManager.open();
    });

    // Answer Screenshot — from Right-Alt+A keyhook (instant answer, no preview)
    window.haimuai.onAnswerScreenshot((dataUrl) => {
      this.processAnswerScreenshot(dataUrl);
    });

    // System audio listen toggle — from Alt+L keyhook
    window.haimuai.onToggleListen(() => {
      this.toggleListen();
    });
  }

  // ========================================
  // Keyboard Shortcuts (renderer-level)
  // ========================================
  setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Escape - close modals/settings
      if (e.key === 'Escape') {
        if (window.settingsManager.isOpen) {
          window.settingsManager.close();
        }
        const screenshotModal = document.getElementById('screenshotModal');
        if (screenshotModal?.classList.contains('active')) {
          window.screenshotManager.hidePreview();
          const promptInput = document.getElementById('screenshotPrompt');
          if (promptInput) promptInput.value = '';
        }
      }

      // Ctrl+N — New Chat
      if (e.ctrlKey && e.key === 'n') {
        // Only if not typing in an input field (let browser handle normal Ctrl+N in inputs)
        if (document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
          e.preventDefault();
          this.newChatAction();
        }
      }

      // Alt+L - cycle languages
      if (e.altKey && e.key === 'l') {
        e.preventDefault();
        const select = document.getElementById('languageSelect');
        if (select) {
          const currentIdx = select.selectedIndex;
          select.selectedIndex = (currentIdx + 1) % select.options.length;
          this.showToast(`Language: ${select.options[select.selectedIndex].text}`, 'info');
        }
      }
    });
  }

  // ========================================
  // Toast Notifications
  // ========================================
  showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    if (this.toastTimer) clearTimeout(this.toastTimer);

    toast.textContent = message;
    toast.className = `toast ${type} show`;

    this.toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }

  // ========================================
  // System Audio Listen Mode
  // ========================================
  setupListen() {
    const listenBtn = document.getElementById('btnListenToggle');
    const stopBtn = document.getElementById('btnStopListen');

    // Create waveform bars inside the listen banner
    const barsContainer = document.getElementById('listenWaveformBars');
    if (barsContainer) {
      barsContainer.innerHTML = Array.from({ length: 32 }, (_, i) =>
        `<div class="listen-bar" data-index="${i}"></div>`
      ).join('');
    }

    // Wire up transcript updates
    window.systemListener.onTranscriptUpdate = (transcript) => {
      const content = document.getElementById('listenTranscriptContent');
      if (content) {
        content.textContent = transcript;
        // Auto-scroll to bottom
        content.scrollTop = content.scrollHeight;
      }
    };

    // Wire up waveform
    window.systemListener.onWaveformUpdate = (bars) => {
      this._updateListenWaveform(bars);
    };

    // Wire up status changes
    window.systemListener.onStatusChange = (status) => {
      if (status === 'listening') {
        listenBtn?.classList.add('active', 'listening');
        document.getElementById('listenBanner')?.classList.add('active');
        this._startListenTimer();
        window.app?.showToast('🎧 Listening to system audio — press Alt+L or Stop to answer', 'success');
      } else if (status === 'stopped') {
        listenBtn?.classList.remove('active', 'listening');
        document.getElementById('listenBanner')?.classList.remove('active');
        this._stopListenTimer();
      }
    };

    // Stop & Answer button
    stopBtn?.addEventListener('click', () => {
      this._stopListenAndAnswer();
    });
  }

  async toggleListen() {
    if (window.systemListener.isListening) {
      this._stopListenAndAnswer();
    } else {
      // Reset transcript UI
      const content = document.getElementById('listenTranscriptContent');
      if (content) {
        content.innerHTML = '<span class="listen-transcript-placeholder">Waiting for audio...</span>';
      }
      const started = await window.systemListener.start();
      if (!started) {
        this.showToast('🎧 Failed to start system audio capture', 'error');
      }
    }
  }

  async _stopListenAndAnswer() {
    const transcript = window.systemListener.stop();

    // Hide the listen banner
    document.getElementById('listenBanner')?.classList.remove('active');
    document.getElementById('btnListenToggle')?.classList.remove('active', 'listening');
    this._stopListenTimer();

    if (!transcript || transcript.trim().length === 0) {
      this.showToast('🎧 No audio detected — nothing to answer', 'warning');
      return;
    }

    // Send transcript to AI for answering
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) welcome.style.display = 'none';

    this.addMessage('user', `🎧 **[System Audio Transcript]**\n\n${transcript}\n\n---\n*Answer all questions from this conversation/audio.*`);
    const aiMsgId = this.addMessage('ai', null, true);

    try {
      const language = document.getElementById('languageSelect')?.value || 'javascript';
      let fullResponse = '';

      await window.aiChat.sendMessage(
        `Here is a transcript of audio I just listened to from my system speakers (could be a Zoom/Meet call, lecture, YouTube video, etc.):\n\n--- TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---\n\nPlease:\n1. Identify ALL questions that were asked in this transcript.\n2. Answer each question completely and correctly.\n3. If it's a lecture/explanation, summarize the key points.\n4. If there are coding problems mentioned, provide full solutions.\n5. Format your response clearly with headers for each question/topic.`,
        'general',
        language,
        (chunk, fullText) => {
          fullResponse = fullText;
          this.updateMessage(aiMsgId, fullText);
        }
      );

      this.lastAIResponse = fullResponse;
      this.updateMessage(aiMsgId, fullResponse, true);
      this.showToast('✅ Audio analyzed and questions answered!', 'success');

    } catch (error) {
      this.updateMessage(aiMsgId, `❌ **Error:** ${error.message}`, true);
      console.error('Listen answer error:', error);
    }
  }

  _updateListenWaveform(data) {
    const bars = document.querySelectorAll('#listenWaveformBars .listen-bar');
    bars.forEach((bar, i) => {
      const value = data[i] || 0;
      const height = Math.max(2, value * 28);
      bar.style.height = `${height}px`;
      bar.style.backgroundColor = `rgba(16, 185, 129, ${0.3 + value * 0.7})`;
    });
  }

  _startListenTimer() {
    const timerEl = document.getElementById('listenTimer');
    if (!timerEl) return;

    const startTime = Date.now();
    this._listenTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
  }

  _stopListenTimer() {
    if (this._listenTimerInterval) {
      clearInterval(this._listenTimerInterval);
      this._listenTimerInterval = null;
    }
    const timerEl = document.getElementById('listenTimer');
    if (timerEl) timerEl.textContent = '0:00';
  }
}

// Initialize app
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new HaimuAiApp();
  window.app = app;
});
