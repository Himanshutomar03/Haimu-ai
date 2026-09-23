// HaimuAi Chat Module — Server-Proxied (no API keys in client) + Free Mode
class AIChat {
  constructor() {
    // ---- Server proxy config (replaces direct Gemini calls) ----
    this.serverUrl = '';          // Set on init via IPC
    this.licenseToken = '';       // Set on init via IPC
    this.model = 'gemini-2.5-flash'; // Passed to server (server can override)

    // ---- Free Mode config ----
    this.freeModeEnabled = false;
    this.freeApiKeys = [];        // [{ provider, key, label }]
    this.freeApiKeyIndex = 0;     // Currently active key index

    this.conversationHistory = [];
    this.isStreaming = false;
    this.abortController = null;
    this.resumeText = '';
    this.interviewMode = false;
    this.interviewTopic = '';
    this.interviewQuestionCount = 0;
    this.onlineInterviewMode = false;
    this.onlineInterviewTopic = '';
    this.interviewDocument = '';
    this.chatSessions = [];
    this.currentSessionId = null;

    // ---- Rate-limit / concurrency management ----
    this._maxConcurrent = 3;
    this._maxRetries = 3;
    this._baseDelay = 1000;
    this._activeRequests = 0;
    this._queue = [];

    // Fetch server URL and token from main process
    this._initServer();
  }

  async _initServer() {
    try {
      this.serverUrl = await window.haimuai.getServerUrl();
      this.licenseToken = await window.haimuai.getLicenseToken();

      // Load free mode config
      const fm = await window.haimuai.getFreeMode();
      this.freeModeEnabled = fm.enabled && (fm.keys || []).length > 0;
      this.freeApiKeys = fm.keys || [];
      this.freeApiKeyIndex = fm.activeIndex || 0;
    } catch (e) {
      console.error('[AIChat] Failed to get server config:', e);
    }
  }

  /** Refresh the license token (called after heartbeat renews it) */
  async _refreshToken() {
    try {
      this.licenseToken = await window.haimuai.getLicenseToken();
    } catch (e) {}
  }

  /** Reload free-mode config from main process */
  async _refreshFreeMode() {
    try {
      const fm = await window.haimuai.getFreeMode();
      this.freeModeEnabled = fm.enabled && (fm.keys || []).length > 0;
      this.freeApiKeys = fm.keys || [];
      this.freeApiKeyIndex = fm.activeIndex || 0;
    } catch (e) {}
  }

  /** Get the currently active free-mode API key */
  _getActiveFreeKey() {
    if (!this.freeApiKeys.length) return null;
    return this.freeApiKeys[this.freeApiKeyIndex % this.freeApiKeys.length];
  }

  /**
   * Rotate to the next free-mode API key.
   * Returns true if a new key is available, false if all keys are exhausted.
   * Marks the current key as exhausted so we don't loop back to it.
   * The exhausted-key set auto-resets after 1 hour (Gemini free quota window).
   */
  _rotateFreeKey(exhaustedIndex) {
    if (!this._exhaustedKeys) this._exhaustedKeys = new Set();
    this._exhaustedKeys.add(exhaustedIndex ?? this.freeApiKeyIndex);

    // Try each key in order to find a non-exhausted one
    for (let i = 1; i <= this.freeApiKeys.length; i++) {
      const nextIdx = (this.freeApiKeyIndex + i) % this.freeApiKeys.length;
      if (!this._exhaustedKeys.has(nextIdx)) {
        this.freeApiKeyIndex = nextIdx;
        // Schedule exhausted-key reset after 1 hour
        if (!this._exhaustedResetTimer) {
          this._exhaustedResetTimer = setTimeout(() => {
            this._exhaustedKeys.clear();
            this._exhaustedResetTimer = null;
            console.log('[FreeMode] Exhausted key list reset — quota windows may have refreshed.');
          }, 60 * 60 * 1000);
        }
        // Notify UI about the switch
        const newKey = this.freeApiKeys[nextIdx];
        this._notifyKeySwitch(newKey?.label || `Key ${nextIdx + 1}`);
        return true; // a fresh key is now active
      }
    }
    return false; // all keys exhausted
  }

  /** Fire a UI toast when auto-switching to next key */
  _notifyKeySwitch(label) {
    try {
      // Dispatch a custom DOM event that app.js can listen to for toast
      document.dispatchEvent(new CustomEvent('free-key-switched', {
        detail: { label }
      }));
    } catch (_) {}
  }

  /** Get the auth headers for every server request */
  _authHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-license-token': this.licenseToken,
    };
  }


  // ---- Provider helpers (kept as stubs for compatibility) ----
  setProvider(p) { /* Server-side only — ignored */ }
  setOllamaModel(m) { /* Ollama removed — server-side only */ }
  setApiKey(key) { /* API key is server-side — ignored */ }
  setApiKeys(keys) { /* API keys are server-side — ignored */ }

  async testOllamaConnection() {
    return { ok: false, error: 'Ollama is not available in this version' };
  }


  setResume(text) {
    this.resumeText = text;
  }

  getResume() {
    return this.resumeText;
  }

  clearResume() {
    this.resumeText = '';
  }

  setInterviewDocument(text) {
    this.interviewDocument = text || '';
  }

  getInterviewDocument() {
    return this.interviewDocument;
  }

  // ========================================
  // Interview Mode
  // ========================================
  startInterview(topic = '') {
    this.interviewMode = true;
    this.interviewTopic = topic;
    this.interviewQuestionCount = 0;
    this.conversationHistory = [];

    // Save as new session
    this.currentSessionId = Date.now().toString();
    this.chatSessions.push({
      id: this.currentSessionId,
      title: `🎯 Interview: ${topic || 'General'}`,
      history: [],
      timestamp: new Date().toISOString(),
      mode: 'interview',
      topic: topic
    });
    this.saveSessions();
  }

  stopInterview() {
    this.interviewMode = false;
    this.interviewTopic = '';
    this.interviewQuestionCount = 0;
  }

  isInterviewActive() {
    return this.interviewMode;
  }

  // ========================================
  // Online Interview Mode (Answer Assist)
  // ========================================
  startOnlineInterview(topic = '') {
    this.onlineInterviewMode = true;
    this.onlineInterviewTopic = topic;
    this.conversationHistory = [];

    // Save as new session
    this.currentSessionId = Date.now().toString();
    this.chatSessions.push({
      id: this.currentSessionId,
      title: `🔴 Online: ${topic || 'General'}`,
      history: [],
      timestamp: new Date().toISOString(),
      mode: 'online-interview',
      topic: topic
    });
    this.saveSessions();
  }

  stopOnlineInterview() {
    this.onlineInterviewMode = false;
    this.onlineInterviewTopic = '';
  }

  isOnlineInterviewActive() {
    return this.onlineInterviewMode;
  }

  // ========================================
  // Chat Sessions (History)
  // ========================================
  saveSessions() {
    try {
      const data = this.chatSessions.map(s => ({
        id: s.id,
        title: s.title,
        history: s.history.slice(-40), // Keep last 40 messages per session
        timestamp: s.timestamp,
        mode: s.mode || 'general',
        topic: s.topic || ''
      }));
      // Keep last 30 sessions
      if (data.length > 30) data.splice(0, data.length - 30);
      localStorage.setItem('haimuai_sessions', JSON.stringify(data));
    } catch (e) {
      console.warn('Failed to save sessions:', e);
    }
  }

  loadSessions() {
    try {
      const data = localStorage.getItem('haimuai_sessions');
      if (data) {
        this.chatSessions = JSON.parse(data);
      }
    } catch (e) {
      console.warn('Failed to load sessions:', e);
      this.chatSessions = [];
    }
    return this.chatSessions;
  }

  getSessions() {
    return this.chatSessions;
  }

  loadSession(sessionId) {
    const session = this.chatSessions.find(s => s.id === sessionId);
    if (session) {
      this.conversationHistory = [...session.history];
      this.currentSessionId = sessionId;
      if (session.mode === 'interview') {
        this.interviewMode = true;
        this.interviewTopic = session.topic || '';
        this.interviewQuestionCount = session.history.filter(h => h.role === 'assistant').length;
        this.onlineInterviewMode = false;
      } else if (session.mode === 'online-interview') {
        this.onlineInterviewMode = true;
        this.onlineInterviewTopic = session.topic || '';
        this.interviewMode = false;
      } else {
        this.interviewMode = false;
        this.onlineInterviewMode = false;
      }
      return session;
    }
    return null;
  }

  deleteSession(sessionId) {
    this.chatSessions = this.chatSessions.filter(s => s.id !== sessionId);
    this.saveSessions();
  }

  saveCurrentToSession() {
    if (!this.currentSessionId) {
      // Create a new general session
      this.currentSessionId = Date.now().toString();
      const firstMsg = this.conversationHistory.find(h => h.role === 'user');
      const title = firstMsg ? firstMsg.content.substring(0, 50) + (firstMsg.content.length > 50 ? '...' : '') : 'New Chat';
      this.chatSessions.push({
        id: this.currentSessionId,
        title: title,
        history: [...this.conversationHistory],
        timestamp: new Date().toISOString(),
        mode: this.interviewMode ? 'interview' : 'general',
        topic: this.interviewTopic
      });
    } else {
      const session = this.chatSessions.find(s => s.id === this.currentSessionId);
      if (session) {
        session.history = [...this.conversationHistory];
        // Update title from first user message if generic
        if (session.title === 'New Chat' && session.history.length > 0) {
          const firstMsg = session.history.find(h => h.role === 'user');
          if (firstMsg) session.title = firstMsg.content.substring(0, 50) + (firstMsg.content.length > 50 ? '...' : '');
        }
      }
    }
    this.saveSessions();
  }

  // ========================================
  // System Prompts
  // ========================================
  getSystemPrompt(command, language) {
    let resumeContext = '';
    if (this.resumeText) {
      resumeContext = `\n\nIMPORTANT CONTEXT - The user has provided their resume/CV. Use this information to personalize ALL your answers. When answering interview questions, coding questions, or any query, base your responses on the user's actual skills, experience, projects, and background from the resume.\n\n--- USER'S RESUME ---\n${this.resumeText}\n--- END RESUME ---\n\n`;
    }

    if (this.interviewMode) {
      const topicStr = this.interviewTopic ? ` focusing on "${this.interviewTopic}"` : '';
      let documentContext = '';
      if (this.interviewDocument) {
        documentContext = `\n\nIMPORTANT — The user has uploaded a document (likely a Job Description, question paper, or study material). Base your interview questions primarily on this document's content, requirements, and topics:\n\n--- UPLOADED DOCUMENT ---\n${this.interviewDocument}\n--- END DOCUMENT ---\n`;
      }
      return `You are a tough but fair technical interviewer conducting a live online interview${topicStr}. You are grilling the candidate with progressively harder questions.
${resumeContext}${documentContext}
RULES:
- Ask ONE question at a time. Wait for the candidate's answer before moving to the next.
- Start with easier questions and gradually increase difficulty.
- After the candidate answers, give brief feedback (1-2 lines), rate their answer (Good/Average/Needs Improvement), then immediately ask the next question.
- Ask follow-up questions based on the candidate's answers to probe deeper.
- Mix theoretical questions, coding problems, scenario-based questions, and behavioral questions.
- If the candidate's resume is provided, ask questions specifically about their projects, skills, and experience mentioned in it.
- Be professional but challenging. Don't be easy on the candidate.
- The preferred programming language is ${language}.
- Use markdown formatting, especially for code blocks.
- Question ${this.interviewQuestionCount + 1} coming up.`;
    }

    if (this.onlineInterviewMode) {
      const topicStr = this.onlineInterviewTopic ? ` in the domain of "${this.onlineInterviewTopic}"` : '';
      let documentContext = '';
      if (this.interviewDocument) {
        documentContext = `\n\nThe user has also uploaded a reference document (JD / question paper / study material). Use it to provide more relevant answers:\n\n--- REFERENCE DOCUMENT ---\n${this.interviewDocument}\n--- END DOCUMENT ---\n`;
      }
      return `You are an expert interview answer coach${topicStr}. The user is currently in a LIVE online interview and needs help answering questions.
${resumeContext}${documentContext}
CRITICAL RULES:
- You will receive the interview question (from screenshot or text).
- Frame a PERFECT, ready-to-speak answer that the user can say directly.
- Write the answer in FIRST PERSON as if the user is speaking. Example: "In my experience working at XYZ, I have..."
- Keep the answer concise but thorough (2-4 paragraphs max for theory, more for coding).
- Sound natural, confident, and conversational — NOT like a textbook.
- If the question is about code, provide the solution clearly with brief verbal explanation of approach.
- If resume is available, weave in relevant personal experience, projects, and skills naturally.
- Do NOT say "The answer is..." or "You should say..." — just give the answer directly as the user would speak it.
- Use bullet points ONLY if the answer naturally benefits from listing (e.g. "What are the features of...").
- For behavioral questions, use the STAR method naturally.
- The preferred programming language is ${language}.
- Use markdown formatting for code blocks if code is involved.`;
    }

    const prompts = {
      explain: `You are a helpful coding assistant. The user wants you to explain code or concepts. 
        Provide clear, concise explanations with examples when helpful. 
        The preferred programming language is ${language}.
        Use markdown formatting for code blocks.${resumeContext}`,

      debug: `You are an expert debugger. The user wants you to find and fix problems in their code.
        Identify bugs, suggest fixes, and explain why the fix works.
        The preferred programming language is ${language}.
        Use markdown formatting for code blocks and diffs.${resumeContext}`,

      generate: `You are a code generation expert. The user wants you to create new code based on their requirements.
        Write clean, well-commented, production-ready code.
        The preferred programming language is ${language}.
        Use markdown formatting for code blocks.${resumeContext}`,

      practice: `You are a coding practice assistant. Generate practice problems and coding challenges.
        Provide problems of varying difficulty with hints and solutions.
        The preferred programming language is ${language}.
        Use markdown formatting for code blocks.${resumeContext}`,

      general: `You are HaimuAi, a helpful AI assistant that works on the user's screen.
        Help with any task - writing, editing, learning, problem-solving, or coding.
        The preferred programming language is ${language}.
        Be concise but thorough. Use markdown formatting.${resumeContext}`
    };
    return prompts[command] || prompts.general;
  }

  async sendMessage(message, command = 'general', language = 'javascript', onChunk = null) {
    await this._refreshToken();

    // Free mode: use user-supplied API key directly
    if (this.freeModeEnabled && this.freeApiKeys.length > 0) {
      await this._refreshFreeMode();
      const systemPrompt = this.getSystemPrompt(command, language);
      if (this.interviewMode) this.interviewQuestionCount++;
      this.conversationHistory.push({ role: 'user', content: message });
      try {
        return await this._sendGeminiDirectMessage(message, systemPrompt, onChunk);
      } catch (error) {
        this.isStreaming = false;
        if (error.name === 'AbortError') return '[Response cancelled]';
        throw error;
      }
    }

    if (!this.licenseToken) {
      throw new Error('License token missing. Please restart HaimuAi.');
    }

    this.isStreaming = true;
    this.abortController = new AbortController();

    const systemPrompt = this.getSystemPrompt(command, language);

    if (this.interviewMode) {
      this.interviewQuestionCount++;
    }

    this.conversationHistory.push({ role: 'user', content: message });

    try {
      return await this._sendServerMessage(message, systemPrompt, onChunk);
    } catch (error) {
      this.isStreaming = false;
      if (error.name === 'AbortError') return '[Response cancelled]';
      throw error;
    }
  }

  // ============================================================
  // SERVER PROXY — Text Chat
  // ============================================================
  async _sendServerMessage(message, systemPrompt, onChunk) {
    const messages = this.conversationHistory.map(h => ({
      role: h.role,
      content: h.content,
    }));

    if (onChunk) {
      // Streaming via SSE
      const response = await this._enqueue(() =>
        fetch(`${this.serverUrl}/api/ai/stream`, {
          method: 'POST',
          headers: this._authHeaders(),
          body: JSON.stringify({ messages, systemPrompt, model: this.model }),
          signal: this.abortController.signal,
        })
      );

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // ── Revoke detection: let heartbeat handle restart gracefully ──
        if (err.revoked === true) {
          console.warn('[HaimuAi] License revoked — heartbeat will handle graceful restart.');
          throw new Error('License revoked. The app will restart automatically in a moment.');
        }
        throw new Error(err.error || `Server error: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (chunk) { fullText += chunk; onChunk(chunk, fullText); }
          } catch (e) {}
        }
      }

      this.conversationHistory.push({ role: 'assistant', content: fullText });
      this.isStreaming = false;
      this.saveCurrentToSession();
      return fullText;
    } else {
      // Non-streaming
      const response = await this._enqueue(() =>
        fetch(`${this.serverUrl}/api/ai/chat`, {
          method: 'POST',
          headers: this._authHeaders(),
          body: JSON.stringify({ messages, systemPrompt, model: this.model }),
          signal: this.abortController.signal,
        })
      );

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // ── Revoke detection: let heartbeat handle restart gracefully ──
        if (err.revoked === true) {
          console.warn('[HaimuAi] License revoked — heartbeat will handle graceful restart.');
          throw new Error('License revoked. The app will restart automatically in a moment.');
        }
        throw new Error(err.error || `Server error: ${response.status}`);
      }

      const data = await response.json();
      const text = data.text || 'No response.';
      this.conversationHistory.push({ role: 'assistant', content: text });
      this.isStreaming = false;
      this.saveCurrentToSession();
      return text;
    }
  }

  // Legacy stubs — kept so nothing breaks if still called
  async _sendGeminiMessage(message, systemPrompt, onChunk) {
    return this._sendServerMessage(message, systemPrompt, onChunk);
  }
  async _sendOllamaMessage(message, systemPrompt, onChunk) {
    return this._sendServerMessage(message, systemPrompt, onChunk);
  }
  async _sendOpenAIMessage(message, systemPrompt, onChunk) {
    return this._sendServerMessage(message, systemPrompt, onChunk);
  }

  // ============================================================
  // FREE MODE — Direct Gemini API call using user's own key
  // Auto-switches to next key on quota errors (429/403)
  // ============================================================
  async _sendGeminiDirectMessage(message, systemPrompt, onChunk) {
    if (!this.freeApiKeys.length) {
      throw new Error('No API key configured. Please add a key in Settings > API Keys.');
    }

    // Build Gemini messages format (shared across retries)
    const contents = this.conversationHistory.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));
    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    };

    this.isStreaming = true;
    this.abortController = new AbortController();

    // Try every key before giving up
    const totalKeys = this.freeApiKeys.length;
    let lastError = null;

    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const keyObj = this._getActiveFreeKey();
      if (!keyObj?.key) break;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${keyObj.key}`;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: this.abortController.signal,
        });

        if (response.ok) {
          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
          if (onChunk) onChunk(text, text);
          this.conversationHistory.push({ role: 'assistant', content: text });
          this.isStreaming = false;
          this.saveCurrentToSession();
          return text;
        }

        // Parse error
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `Gemini API error: ${response.status}`;
        lastError = new Error(errMsg);

        // Quota / rate-limit → auto-switch key and retry immediately
        if (response.status === 429 || response.status === 403) {
          const currentIdx = this.freeApiKeyIndex;
          console.warn(`[FreeMode] Key "${keyObj.label || currentIdx}" quota hit (${response.status}). Trying next key…`);
          const hasNext = this._rotateFreeKey(currentIdx);
          if (!hasNext) break; // all keys exhausted
          continue;           // retry with new key
        }

        // Non-quota error (bad key format, permission error, etc.) → don't retry
        break;

      } catch (err) {
        if (err.name === 'AbortError') {
          this.isStreaming = false;
          return '[Response cancelled]';
        }
        lastError = err;
        break;
      }
    }

    this.isStreaming = false;
    throw lastError || new Error('All API keys exhausted. Please add more keys or wait for quota to reset.');
  }

  // ============================================================
  // FREE MODE — Direct Gemini Vision (screenshot analysis)
  // Auto-switches to next key on quota errors (429/403)
  // ============================================================
  async _analyzeGeminiDirectVision(imageDataArray, systemContent, question) {
    if (!this.freeApiKeys.length) {
      throw new Error('No API key configured. Please add a key in Settings > API Keys.');
    }

    // Build parts with all images (shared across retries)
    const imageParts = imageDataArray.map(dataUrl => {
      const [header, data] = dataUrl.split(',');
      const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
      return { inline_data: { mime_type: mimeType, data } };
    });
    const body = {
      system_instruction: { parts: [{ text: systemContent }] },
      contents: [{
        role: 'user',
        parts: [...imageParts, { text: question }]
      }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
    };

    const totalKeys = this.freeApiKeys.length;
    let lastError = null;

    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const keyObj = this._getActiveFreeKey();
      if (!keyObj?.key) break;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${keyObj.key}`;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          const data = await response.json();
          return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not analyze screenshot(s).';
        }

        const errData = await response.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `Gemini Vision API error: ${response.status}`;
        lastError = new Error(errMsg);

        if (response.status === 429 || response.status === 403) {
          const currentIdx = this.freeApiKeyIndex;
          console.warn(`[FreeMode] Vision key "${keyObj.label || currentIdx}" quota hit (${response.status}). Trying next key…`);
          const hasNext = this._rotateFreeKey(currentIdx);
          if (!hasNext) break;
          continue;
        }
        break;

      } catch (err) {
        lastError = err;
        break;
      }
    }

    throw lastError || new Error('All API keys exhausted. Please add more keys or wait for quota to reset.');
  }

  // =============================================
  // Request Queue & Rate-Limit Helpers
  // =============================================

  /** Enqueue a request function; executes up to _maxConcurrent at a time */
  _enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this._activeRequests < this._maxConcurrent && this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      this._activeRequests++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this._activeRequests--;
          this._drain();
        });
    }
  }

  /** Exponential-backoff fetch — retries on 429 and 5xx */
  async _fetchWithRetry(url, options, attempt = 0) {
    const response = await fetch(url, options);
    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      if (attempt >= this._maxRetries) return response; // give up, let caller handle
      // Honour Retry-After header if present
      const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
      const delay = retryAfter * 1000 || this._baseDelay * Math.pow(2, attempt);
      console.warn(`[HaimuAi] Rate-limited (${response.status}). Retrying in ${delay}ms (attempt ${attempt + 1}/${this._maxRetries})…`);
      await new Promise(r => setTimeout(r, delay));
      return this._fetchWithRetry(url, options, attempt + 1);
    }
    return response;
  }

  // Legacy stub (unused but kept for safety)
  async _sendOpenAIMessage(message, systemPrompt, onChunk) {
    return this._sendGeminiMessage(message, systemPrompt, onChunk);
  }

  async analyzeScreenshot(imageData, question = 'What do you see in this screenshot? Describe it and help the user.', language = 'javascript', syncWithChat = true) {
    return this.analyzeScreenshots([imageData], question, language, syncWithChat);
  }

  // Analyze one or more screenshots at once
  async analyzeScreenshots(imageDataArray, question = 'What do you see in these screenshots? Describe and help the user.', language = 'javascript', syncWithChat = true) {
    await this._refreshToken();
    if (!this.licenseToken) {
      throw new Error('License token missing. Please restart HaimuAi.');
    }
    if (!imageDataArray || imageDataArray.length === 0) {
      throw new Error('No screenshots provided.');
    }

    let resumeContext = '';
    if (this.resumeText) {
      resumeContext = ` The user's resume is loaded - use it for context if relevant.`;
    }

    let systemContent;
    let effectiveQuestion = question;

    if (this.onlineInterviewMode) {
      const topicStr = this.onlineInterviewTopic ? ` in the domain of "${this.onlineInterviewTopic}"` : '';
      let resumeBlock = '';
      if (this.resumeText) {
        resumeBlock = `\n\nUSER'S RESUME (use this to personalize the answer with real experience):\n${this.resumeText}\n`;
      }
      systemContent = `You are an expert interview answer coach${topicStr}. The user is in a LIVE online interview. They just captured their screen showing the interviewer's question.${resumeBlock}

CRITICAL RULES:
- Read the question from the screenshot(s).
- Frame a PERFECT, ready-to-speak answer in FIRST PERSON as if the user is speaking.
- Sound natural, confident, and conversational. NOT robotic or textbook-like.
- Keep it concise but thorough (2-4 paragraphs for theory, clear code for coding questions).
- If resume is available, naturally weave in the user's real experience and projects.
- Do NOT say "The answer is" or "You should say" — just give the direct answer as the user would speak it.
- Use markdown formatting for any code blocks.
- The preferred programming language is ${language}.`;
      effectiveQuestion = question === 'What do you see in these screenshots? Describe and help the user.'
        ? 'Read the interview question from these screenshot(s) and give me a perfect answer I can speak directly.'
        : question;
    } else {
      systemContent = syncWithChat && this.conversationHistory.length > 0
        ? `You are HaimuAi, an AI assistant analyzing the user's screen. You are in an ongoing conversation with the user — use the previous messages as context to provide a more relevant and helpful analysis. The preferred programming language is ${language}. Use markdown formatting.${resumeContext}`
        : `You are HaimuAi, an AI assistant analyzing the user's screen. Help the user with what you see. The preferred programming language is ${language}. Use markdown formatting.${resumeContext}`;
    }

    let result;
    // Free mode: use direct Gemini API
    if (this.freeModeEnabled && this.freeApiKeys.length > 0) {
      await this._refreshFreeMode();
      result = await this._analyzeGeminiDirectVision(imageDataArray, systemContent, effectiveQuestion);
    } else {
      // Always use server proxy for vision
      result = await this._analyzeServerVision(imageDataArray, systemContent, effectiveQuestion, syncWithChat);
    }

    // Add to conversation history so future messages have this context
    if (syncWithChat) {
      const n = imageDataArray.length;
      this.conversationHistory.push({ role: 'user', content: `[${n} Screenshot${n > 1 ? 's' : ''} captured] ${question}` });
      this.conversationHistory.push({ role: 'assistant', content: result });
      this.saveCurrentToSession();
    }

    return result;
  }

  // ============================================================
  // SERVER PROXY — Vision / Screenshot Analysis
  // ============================================================
  async _analyzeServerVision(imageDataArray, systemContent, question, syncWithChat) {
    // Use the first image for simple case, send all for multi
    const imageBase64 = imageDataArray[0]; // server handles stripping prefix

    // Build context from recent history
    const contextMessages = syncWithChat && this.conversationHistory.length > 0
      ? this.conversationHistory.slice(-6).map(h => ({ role: h.role, content: h.content }))
      : [];

    // For multi-image, embed all images in the prompt text (server will handle)
    const multiImageNote = imageDataArray.length > 1
      ? `\n[Note: User provided ${imageDataArray.length} screenshots]`
      : '';

    const response = await this._enqueue(() =>
      fetch(`${this.serverUrl}/api/ai/vision`, {
        method: 'POST',
        headers: this._authHeaders(),
        body: JSON.stringify({
          imageBase64,
          prompt: question + multiImageNote,
          messages: contextMessages,
          systemPrompt: systemContent,
          model: this.model,
        }),
      })
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      // ── Revoke detection: let heartbeat handle restart gracefully ──
      if (err.revoked === true) {
        console.warn('[HaimuAi] License revoked — heartbeat will handle graceful restart.');
        throw new Error('License revoked. The app will restart automatically in a moment.');
      }
      throw new Error(err.error || `Vision server error: ${response.status}`);
    }

    const data = await response.json();
    return data.text || 'Could not analyze screenshot(s).';
  }

  // Legacy stubs for vision
  async _analyzeGeminiVision(imageData, systemContent, question, syncWithChat) {
    return this._analyzeServerVision([imageData], systemContent, question, syncWithChat);
  }
  async _analyzeGeminiVisionMulti(imageDataArray, systemContent, question, syncWithChat) {
    return this._analyzeServerVision(imageDataArray, systemContent, question, syncWithChat);
  }
  async _analyzeOllamaVision(imageData, systemContent, question) {
    return this._analyzeServerVision([imageData], systemContent, question, false);
  }
  async _analyzeOpenAIVision(imageData, systemContent, question, syncWithChat) {
    return this._analyzeServerVision([imageData], systemContent, question, syncWithChat);
  }

  cancelStream() {
    if (this.abortController) {
      this.abortController.abort();
      this.isStreaming = false;
    }
  }

  clearHistory() {
    this.conversationHistory = [];
    this.currentSessionId = null;
  }

  newChat() {
    this.conversationHistory = [];
    this.currentSessionId = null;
    this.interviewMode = false;
    this.interviewTopic = '';
    this.interviewQuestionCount = 0;
    this.onlineInterviewMode = false;
    this.onlineInterviewTopic = '';
    this.interviewDocument = '';
  }
}

window.aiChat = new AIChat();
