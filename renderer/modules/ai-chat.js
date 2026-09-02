// HaimuAi Chat Module - Multi-Provider (Gemini / Ollama)
class AIChat {
  constructor() {
    // ---- Provider config ----
    this.provider = 'gemini';          // 'gemini' | 'ollama'
    // ---- API Key Pool (Gemini) ----
    // apiKey kept for legacy compatibility; apiKeys[] is the authoritative list
    this.apiKey = 'AIzaSyDPlfZ80yqHlhJ6Sqm_XznxX6qI_AmOYFI';
    this.apiKeys = ['AIzaSyDPlfZ80yqHlhJ6Sqm_XznxX6qI_AmOYFI'];
    this._keyIndex = 0;                // which key in the pool is active
    this._keyQuotaExhausted = {};      // { keyIndex: true } for exhausted keys
    this.model = 'gemini-2.5-flash';   // Gemini model
    this.baseURL = 'https://generativelanguage.googleapis.com/v1beta';
    this.ollamaModel = 'llama3.2';     // Ollama local model
    this.ollamaBaseURL = 'http://localhost:11434';

    this.conversationHistory = [];
    this.isStreaming = false;
    this.abortController = null;
    this.resumeText = '';
    this.interviewMode = false;
    this.interviewTopic = '';
    this.interviewQuestionCount = 0;
    this.onlineInterviewMode = false;
    this.onlineInterviewTopic = '';
    this.interviewDocument = '';  // Uploaded JD/question paper text
    this.chatSessions = []; // { id, title, history, timestamp, mode }
    this.currentSessionId = null;

    // ---- Rate-limit / concurrency management ----
    this._maxConcurrent = 3;
    this._maxRetries = 5;
    this._baseDelay = 1000;
    this._activeRequests = 0;
    this._queue = [];
  }

  // ---- Provider helpers ----
  setProvider(p) {
    this.provider = p || 'gemini';
  }

  setOllamaModel(m) {
    if (m) this.ollamaModel = m;
  }

  async testOllamaConnection() {
    try {
      const res = await fetch(`${this.ollamaBaseURL}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  setApiKey(key) {
    if (key) {
      this.apiKey = key;
      // Also make it the sole key in pool if pool is empty
      if (!this.apiKeys || this.apiKeys.length === 0) {
        this.apiKeys = [key];
        this._keyIndex = 0;
      }
    }
  }

  /** Set the full pool of Gemini API keys */
  setApiKeys(keys) {
    if (!Array.isArray(keys)) return;
    // Filter out blank entries
    const valid = keys.map(k => k.trim()).filter(Boolean);
    if (valid.length === 0) return;
    this.apiKeys = valid;
    this.apiKey = valid[0];  // keep legacy field in sync
    this._keyIndex = 0;
    this._keyQuotaExhausted = {};
  }

  /** Returns the currently active API key */
  _getActiveKey() {
    if (!this.apiKeys || this.apiKeys.length === 0) return this.apiKey;
    return this.apiKeys[this._keyIndex];
  }

  /**
   * Marks the current key as quota-exhausted and rotates to the next one.
   * Returns true if a new key is available, false if all keys are exhausted.
   */
  _rotateKey() {
    this._keyQuotaExhausted[this._keyIndex] = true;
    const n = this.apiKeys.length;
    for (let i = 1; i <= n; i++) {
      const next = (this._keyIndex + i) % n;
      if (!this._keyQuotaExhausted[next]) {
        this._keyIndex = next;
        this.apiKey = this.apiKeys[next];
        console.warn(`[HaimuAi] API key rotated → key #${next + 1} of ${n}`);
        // Notify UI
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('api-key-rotated', {
            detail: { keyIndex: next, total: n }
          }));
        }
        return true;
      }
    }
    console.error('[HaimuAi] All API keys exhausted!');
    return false; // all keys dead
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
    if (this.provider === 'ollama') {
      // No API key needed for local Ollama
    } else if (!this._getActiveKey()) {
      throw new Error('Gemini API key not set. Please add it in Settings.');
    }

    this.isStreaming = true;
    this.abortController = new AbortController();

    const systemPrompt = this.getSystemPrompt(command, language);

    if (this.interviewMode) {
      this.interviewQuestionCount++;
    }

    this.conversationHistory.push({ role: 'user', content: message });

    try {
      if (this.provider === 'ollama') {
        return await this._sendOllamaMessage(message, systemPrompt, onChunk);
      }
      return await this._sendGeminiMessage(message, systemPrompt, onChunk);
    } catch (error) {
      this.isStreaming = false;
      if (error.name === 'AbortError') return '[Response cancelled]';
      throw error;
    }
  }

  // ============================================================
  // OLLAMA (local) backend
  // ============================================================
  async _sendOllamaMessage(message, systemPrompt, onChunk) {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory.slice(0, -1),
      { role: 'user', content: message }
    ];

    const body = {
      model: this.ollamaModel,
      messages,
      stream: !!onChunk
    };

    const response = await fetch(`${this.ollamaBaseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController.signal
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`Ollama error ${response.status}: ${txt}`);
    }

    if (onChunk) {
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
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const chunk = parsed.message?.content || '';
            if (chunk) { fullText += chunk; onChunk(chunk, fullText); }
            if (parsed.done) break;
          } catch (e) {}
        }
      }

      this.conversationHistory.push({ role: 'assistant', content: fullText });
      this.isStreaming = false;
      this.saveCurrentToSession();
      return fullText;
    } else {
      const data = await response.json();
      const text = data.message?.content || 'No response.';
      this.conversationHistory.push({ role: 'assistant', content: text });
      this.isStreaming = false;
      this.saveCurrentToSession();
      return text;
    }
  }

  // ============================================================
  // GEMINI backend
  // ============================================================
  async _sendGeminiMessage(message, systemPrompt, onChunk) {
    // Build Gemini contents from history
    const contents = this.conversationHistory.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));

    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
    };

    const endpoint = onChunk ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${this.baseURL}/models/${this.model}:${endpoint}&key=${this._getActiveKey()}`;

    let response;
    let rotationAttempts = 0;
    const maxRotations = this.apiKeys.length;

    while (rotationAttempts <= maxRotations) {
      const activeUrl = `${this.baseURL}/models/${this.model}:${endpoint}&key=${this._getActiveKey()}`;
      response = await this._enqueue(() =>
        this._fetchWithRetry(activeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: this.abortController.signal
        })
      );

      // Check for quota error → rotate key and retry
      if (response.status === 429 || response.status === 403) {
        const errBody = await response.clone().json().catch(() => ({}));
        const errMsg = (errBody.error?.message || '').toLowerCase();
        const isQuota = response.status === 429 ||
          errMsg.includes('quota') ||
          errMsg.includes('resource_exhausted') ||
          errMsg.includes('rate limit');
        if (isQuota) {
          const rotated = this._rotateKey();
          if (!rotated) break;  // all keys dead, fall through to error
          rotationAttempts++;
          continue;
        }
      }
      break;  // success or non-quota error
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini error: ${response.status}`);
    }

    if (onChunk) {
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
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
      this.conversationHistory.push({ role: 'assistant', content: text });
      this.isStreaming = false;
      this.saveCurrentToSession();
      return text;
    }
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
    if (this.provider !== 'ollama' && !this._getActiveKey()) {
      throw new Error('Gemini API key not set.');
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
    if (this.provider === 'ollama') {
      // Ollama vision: analyze first image only (llava doesn't reliably support multi-image)
      result = await this._analyzeOllamaVision(imageDataArray[0], systemContent, effectiveQuestion);
    } else {
      result = await this._analyzeGeminiVisionMulti(imageDataArray, systemContent, effectiveQuestion, syncWithChat);
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

  // Ollama vision (uses llava model)
  async _analyzeOllamaVision(imageData, systemContent, question) {
    // Strip data URL prefix to get raw base64
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    const visionModel = this.ollamaModel.includes('llava') ? this.ollamaModel : 'llava';

    const body = {
      model: visionModel,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: question, images: [base64] }
      ],
      stream: false
    };

    const response = await fetch(`${this.ollamaBaseURL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(`Ollama vision error ${response.status}: ${txt}`);
    }

    const data = await response.json();
    return data.message?.content || 'Could not analyze screenshot with Ollama.';
  }

  // Gemini vision (single image — legacy)
  async _analyzeGeminiVision(imageData, systemContent, question, syncWithChat) {
    return this._analyzeGeminiVisionMulti([imageData], systemContent, question, syncWithChat);
  }

  // Gemini vision — supports multiple images in one request
  async _analyzeGeminiVisionMulti(imageDataArray, systemContent, question, syncWithChat) {
    const contextParts = [];
    if (syncWithChat && this.conversationHistory.length > 0) {
      this.conversationHistory.slice(-6).forEach(h => {
        contextParts.push({ text: `${h.role === 'assistant' ? 'Assistant' : 'User'}: ${h.content}` });
      });
    }

    // Build inline_data parts for each image
    const imageParts = imageDataArray.map(imageData => {
      const mimeType = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/png';
      const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
      return { inline_data: { mime_type: mimeType, data: base64 } };
    });

    // Prefix text label when there are multiple images
    const labelPart = imageDataArray.length > 1
      ? [{ text: `The user has provided ${imageDataArray.length} screenshots. Analyze them together.` }]
      : [];

    const body = {
      systemInstruction: { parts: [{ text: systemContent }] },
      contents: [{
        role: 'user',
        parts: [
          ...contextParts,
          ...labelPart,
          { text: question },
          ...imageParts
        ]
      }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
    };

    const url = `${this.baseURL}/models/${this.model}:generateContent?key=${this._getActiveKey()}`;
    let response = await this._enqueue(() =>
      this._fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    );

    // Rotate key on quota errors for vision too
    let rotationAttempts = 0;
    while ((response.status === 429 || response.status === 403) && rotationAttempts < this.apiKeys.length) {
      const errBody = await response.clone().json().catch(() => ({}));
      const errMsg = (errBody.error?.message || '').toLowerCase();
      if (errMsg.includes('quota') || errMsg.includes('resource_exhausted') || response.status === 429) {
        const rotated = this._rotateKey();
        if (!rotated) break;
        rotationAttempts++;
        const newUrl = `${this.baseURL}/models/${this.model}:generateContent?key=${this._getActiveKey()}`;
        response = await this._enqueue(() =>
          this._fetchWithRetry(newUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          })
        );
      } else break;
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini vision error: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not analyze screenshot(s).';
  }

  // Legacy alias
  async _analyzeOpenAIVision(imageData, systemContent, question, syncWithChat) {
    return this._analyzeGeminiVision(imageData, systemContent, question, syncWithChat);
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
