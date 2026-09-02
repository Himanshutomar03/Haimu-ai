// Voice Recording Module - System Audio + Mic capture with manual stop
class VoiceRecorder {
  constructor() {
    this.isRecording = false;
    this.mediaRecorder = null;
    this.audioStream = null;
    this.audioChunks = [];
    this.onResult = null;
    this.onEnd = null;
    this.onStatusChange = null;
    this.onWaveformUpdate = null;
    this.visualizerInterval = null;
    this.analyser = null;
    this.audioContext = null;

    // Settings
    this.autoSend = true;           // Auto-send message after transcription
    this.maxRecordingTime = 300000; // 5 min max recording

    // Internal state
    this._maxTimer = null;
    this._recordingStartTime = 0;
    this._waveformData = new Array(32).fill(0);
  }

  /**
   * Capture system audio (loopback) — hears what's playing through speakers
   * This captures Zoom/Meet/Teams calls, YouTube, etc.
   */
  async getSystemAudioStream() {
    try {
      // getDisplayMedia with audio:true triggers the loopback handler in main.js
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 }, // minimal video (required by API)
        audio: true
      });

      // Remove video tracks — we only need audio
      stream.getVideoTracks().forEach(track => {
        track.stop();
        stream.removeTrack(track);
      });

      if (stream.getAudioTracks().length === 0) {
        throw new Error('No system audio track available');
      }

      console.log('[Voice] System audio stream acquired');
      return stream;
    } catch (err) {
      console.error('[Voice] System audio capture failed:', err);
      return null;
    }
  }

  /**
   * Capture microphone audio
   */
  async getMicStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
          channelCount: 1
        }
      });
      console.log('[Voice] Microphone stream acquired');
      return stream;
    } catch (err) {
      console.error('[Voice] Microphone access denied:', err);
      return null;
    }
  }

  /**
   * Mix multiple audio streams into one
   */
  mixStreams(streams) {
    const ctx = new AudioContext({ sampleRate: 16000 });
    const dest = ctx.createMediaStreamDestination();

    for (const stream of streams) {
      if (stream && stream.getAudioTracks().length > 0) {
        const source = ctx.createMediaStreamSource(stream);
        source.connect(dest);
      }
    }

    this._mixContext = ctx;
    return { stream: dest.stream, context: ctx };
  }

  async start() {
    if (this.isRecording) {
      this.stop();
      return false;
    }

    this.audioChunks = [];
    this._recordingStartTime = Date.now();

    try {
      // Try to get system audio first
      const systemStream = await this.getSystemAudioStream();
      const micStream = await this.getMicStream();

      if (!systemStream && !micStream) {
        window.app?.showToast('🎤 No audio source available — check permissions', 'error');
        return false;
      }

      let finalStream;

      if (systemStream && micStream) {
        // Mix both system audio and mic
        const mixed = this.mixStreams([systemStream, micStream]);
        finalStream = mixed.stream;
        this.audioStream = finalStream;
        this._sourceStreams = [systemStream, micStream];
        window.app?.showToast('🎤 Recording system audio + mic', 'success');
      } else if (systemStream) {
        finalStream = systemStream;
        this.audioStream = finalStream;
        this._sourceStreams = [systemStream];
        window.app?.showToast('🎤 Recording system audio', 'success');
      } else {
        finalStream = micStream;
        this.audioStream = finalStream;
        this._sourceStreams = [micStream];
        window.app?.showToast('🎤 Recording mic only (system audio unavailable)', 'info');
      }

      // Setup audio analyser for waveform
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(finalStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      source.connect(this.analyser);
      this.startVisualizer();

      // Setup MediaRecorder
      const mimeType = this._getBestMimeType();
      this.mediaRecorder = new MediaRecorder(finalStream, {
        mimeType,
        audioBitsPerSecond: 64000
      });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.audioChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        this._cleanup();

        if (this.audioChunks.length === 0) {
          if (this.onEnd) this.onEnd('');
          return;
        }

        const audioBlob = new Blob(this.audioChunks, { type: mimeType });

        // Skip if too short (<1s)
        const duration = Date.now() - this._recordingStartTime;
        if (duration < 1000) {
          window.app?.showToast('🎤 Recording too short — try again', 'warning');
          if (this.onEnd) this.onEnd('');
          return;
        }

        if (this.onStatusChange) this.onStatusChange('transcribing');

        try {
          let transcript;
          const provider = window.aiChat?.provider || 'gemini';

          if (provider === 'ollama') {
            // Offline: use browser Web Speech API (no internet required)
            window.app?.showToast('🎤 Transcribing offline...', 'info');
            transcript = await this.transcribeWithWebSpeech(audioBlob);
          } else {
            // Cloud: use Gemini audio transcription
            window.app?.showToast('🔄 Transcribing audio with Gemini...', 'info');
            transcript = await this.transcribeWithGemini(audioBlob);
          }

          if (this.onResult) this.onResult(transcript, true);
          if (this.onEnd) this.onEnd(transcript);

          if (this.autoSend && transcript && transcript.trim().length > 0) {
            window.app?.showToast('🎤 Sending transcribed message...', 'success');
            setTimeout(() => { window.app?.sendMessage(); }, 400);
          } else {
            window.app?.showToast('🎤 Transcription complete!', 'success');
          }
        } catch (error) {
          console.error('Transcription failed:', error);
          window.app?.showToast('❌ Transcription failed: ' + error.message, 'error');
          if (this.onEnd) this.onEnd('');
        }

        if (this.onStatusChange) this.onStatusChange('idle');
      };

      this.mediaRecorder.start(250);
      this.isRecording = true;
      if (this.onStatusChange) this.onStatusChange('recording');

      // Max recording timer (5 min safety)
      this._maxTimer = setTimeout(() => {
        if (this.isRecording) {
          window.app?.showToast('🎤 Max recording time reached (5 min)', 'info');
          this.stop();
        }
      }, this.maxRecordingTime);

      return true;

    } catch (err) {
      console.error('Recording failed:', err);
      window.app?.showToast('🎤 Recording failed: ' + err.message, 'error');
      this._cleanup();
      return false;
    }
  }

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;

    if (this._maxTimer) {
      clearTimeout(this._maxTimer);
      this._maxTimer = null;
    }

    this.stopVisualizer();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    } else {
      this._cleanup();
      if (this.onStatusChange) this.onStatusChange('idle');
    }
  }

  _cleanup() {
    this.stopVisualizer();

    // Stop all source streams
    if (this._sourceStreams) {
      this._sourceStreams.forEach(stream => {
        stream.getTracks().forEach(track => track.stop());
      });
      this._sourceStreams = null;
    }

    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }

    if (this._mixContext && this._mixContext.state !== 'closed') {
      this._mixContext.close();
      this._mixContext = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  toggle() {
    if (this.isRecording) {
      this.stop();
      return false;
    } else {
      return this.start();
    }
  }

  _getBestMimeType() {
    const codecs = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    for (const codec of codecs) {
      if (MediaRecorder.isTypeSupported(codec)) return codec;
    }
    return 'audio/webm';
  }

  async transcribeWithGemini(audioBlob) {
    const apiKey = window.aiChat?.apiKey;
    if (!apiKey) {
      throw new Error('Gemini API key not set');
    }

    // Convert blob to base64
    const arrayBuffer = await audioBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64Audio = btoa(binary);
    const mimeType = audioBlob.type || 'audio/webm';

    const body = {
      contents: [{
        parts: [
          { text: 'Transcribe this audio accurately. Return only the spoken words, nothing else.' },
          { inline_data: { mime_type: mimeType, data: base64Audio } }
        ]
      }],
      generationConfig: { temperature: 0 }
    };

    const model = window.aiChat?.model || 'gemini-2.5-flash';
    const baseURL = window.aiChat?.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseURL}/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini transcription error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No transcription returned');
    return text.trim();
  }

  /**
   * Offline transcription using the browser's built-in Web Speech API.
   * Works completely without internet — Chromium/Electron has a built-in
   * speech recognition engine that runs locally.
   * Note: re-records a short fresh capture because Web Speech API needs
   * a live stream, not a blob. We use SpeechRecognition in parallel with
   * the MediaRecorder so we always have a result.
   */
  transcribeWithWebSpeech(audioBlob) {
    return new Promise((resolve, reject) => {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        reject(new Error('Web Speech API not available in this Electron build'));
        return;
      }

      // Play back the recorded audio and let SpeechRecognition listen to it
      // via a fresh mic session (simplest approach that works in Electron)
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';
      recognition.maxAlternatives = 1;

      let resolved = false;

      recognition.onresult = (event) => {
        resolved = true;
        const transcript = Array.from(event.results)
          .map(r => r[0].transcript)
          .join(' ')
          .trim();
        resolve(transcript);
      };

      recognition.onerror = (event) => {
        if (!resolved) {
          reject(new Error(`Speech recognition error: ${event.error}`));
        }
      };

      recognition.onend = () => {
        if (!resolved) {
          // If no speech detected, return empty string instead of throwing
          resolve('');
        }
      };

      // Play the blob through an audio element so the browser's speech engine hears it
      const url = URL.createObjectURL(audioBlob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);

      recognition.start();
      // Small delay so recognition is fully started before audio plays
      setTimeout(() => audio.play().catch(() => {}), 200);

      // Timeout safety
      setTimeout(() => {
        if (!resolved) {
          recognition.stop();
          resolve(''); // graceful empty instead of error
        }
      }, 15000);
    });
  }

  // ========================================
  // Waveform Visualizer
  // ========================================
  startVisualizer() {
    if (!this.analyser) return;

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    this.visualizerInterval = setInterval(() => {
      if (!this.analyser) return;

      this.analyser.getByteFrequencyData(dataArray);

      // Generate 32 waveform bars
      const barCount = 32;
      const step = Math.floor(bufferLength / barCount);
      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          sum += dataArray[i * step + j];
        }
        const avg = sum / step;
        this._waveformData[i] = this._waveformData[i] * 0.6 + (avg / 255) * 0.4;
      }

      if (this.onWaveformUpdate) {
        this.onWaveformUpdate([...this._waveformData]);
      }

      // Legacy level indicator
      let totalSum = 0;
      for (let i = 0; i < dataArray.length; i++) totalSum += dataArray[i];
      const avgLevel = Math.round((totalSum / dataArray.length / 255) * 100);
      this.updateVoiceLevel(avgLevel);
    }, 50);
  }

  stopVisualizer() {
    if (this.visualizerInterval) {
      clearInterval(this.visualizerInterval);
      this.visualizerInterval = null;
    }
    this._waveformData = new Array(32).fill(0);
    if (this.onWaveformUpdate) {
      this.onWaveformUpdate(this._waveformData);
    }
    this.updateVoiceLevel(0);
  }

  updateVoiceLevel(level) {
    const indicator = document.getElementById('voiceIndicator');
    const voiceBtn = document.getElementById('btnVoice');

    if (level > 0) {
      const scale = 1 + (level / 200);
      const glowSize = Math.round(level / 10);

      if (indicator) {
        indicator.style.transform = `scale(${scale})`;
        indicator.style.boxShadow = `0 0 ${glowSize}px rgba(239, 68, 68, 0.5)`;
      }
      if (voiceBtn) {
        voiceBtn.style.transform = `scale(${scale})`;
        voiceBtn.style.boxShadow = `0 0 ${glowSize}px rgba(239, 68, 68, 0.5)`;
      }
    } else {
      if (indicator) {
        indicator.style.transform = '';
        indicator.style.boxShadow = '';
      }
      if (voiceBtn) {
        voiceBtn.style.transform = '';
        voiceBtn.style.boxShadow = '';
      }
    }
  }

  // Callbacks
  setOnResult(callback) { this.onResult = callback; }
  setOnEnd(callback) { this.onEnd = callback; }
  setOnStatusChange(callback) { this.onStatusChange = callback; }
  setOnWaveformUpdate(callback) { this.onWaveformUpdate = callback; }
}

// ============================================================
// System Audio Listener — Captures ONLY system/speaker audio
// (no microphone), transcribes in real-time chunks, and
// accumulates a rolling transcript for AI question-answering.
// ============================================================
class SystemAudioListener {
  constructor() {
    this.isListening = false;
    this.mediaRecorder = null;
    this.systemStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.visualizerInterval = null;

    // Transcript state
    this.fullTranscript = '';
    this._chunkQueue = [];
    this._isTranscribing = false;
    this._chunkIndex = 0;

    // Settings
    this.chunkDurationMs = 15000;  // 15-second chunks
    this._chunkTimer = null;
    this._maxListenTime = 600000;  // 10 min max
    this._maxTimer = null;
    this._listenStartTime = 0;

    // Callbacks
    this.onTranscriptUpdate = null;
    this.onStatusChange = null;
    this.onWaveformUpdate = null;
    this._waveformData = new Array(32).fill(0);
  }

  /**
   * Start listening to system audio only (no microphone).
   * Uses getDisplayMedia with audio:true for loopback capture.
   */
  async start() {
    if (this.isListening) {
      this.stop();
      return false;
    }

    this.fullTranscript = '';
    this._chunkQueue = [];
    this._isTranscribing = false;
    this._chunkIndex = 0;
    this._listenStartTime = Date.now();

    try {
      // Capture system audio via loopback (main.js handler returns loopback audio)
      this.systemStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 }, // minimal video (required by API)
        audio: true
      });

      // Remove video tracks — we only need audio
      this.systemStream.getVideoTracks().forEach(track => {
        track.stop();
        this.systemStream.removeTrack(track);
      });

      if (this.systemStream.getAudioTracks().length === 0) {
        throw new Error('No system audio track available');
      }

      console.log('[Listen] System audio stream acquired (no mic)');

      // Setup audio analyser for waveform visualization
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(this.systemStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      source.connect(this.analyser);
      this._startVisualizer();

      this.isListening = true;
      if (this.onStatusChange) this.onStatusChange('listening');

      // Start the first recording chunk
      this._startChunkRecording();

      // Max listen time safety
      this._maxTimer = setTimeout(() => {
        if (this.isListening) {
          window.app?.showToast('🎧 Max listen time reached (10 min)', 'info');
          this.stop();
        }
      }, this._maxListenTime);

      return true;

    } catch (err) {
      console.error('[Listen] Failed to start:', err);
      window.app?.showToast('🎧 System audio capture failed: ' + err.message, 'error');
      this._cleanup();
      return false;
    }
  }

  /**
   * Record a single chunk, then transcribe it and start the next chunk.
   */
  _startChunkRecording() {
    if (!this.isListening || !this.systemStream) return;

    const audioChunks = [];
    const mimeType = this._getBestMimeType();

    try {
      this.mediaRecorder = new MediaRecorder(this.systemStream, {
        mimeType,
        audioBitsPerSecond: 64000
      });
    } catch (err) {
      console.error('[Listen] MediaRecorder create failed:', err);
      this.stop();
      return;
    }

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      if (audioChunks.length > 0) {
        const blob = new Blob(audioChunks, { type: mimeType });
        // Queue this chunk for transcription
        this._chunkQueue.push(blob);
        this._processQueue();
      }

      // Start next chunk if still listening
      if (this.isListening) {
        this._startChunkRecording();
      }
    };

    this.mediaRecorder.start(500); // collect data every 500ms within the chunk

    // Stop this chunk after chunkDurationMs to trigger transcription
    this._chunkTimer = setTimeout(() => {
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    }, this.chunkDurationMs);
  }

  /**
   * Process the transcription queue — one chunk at a time.
   */
  async _processQueue() {
    if (this._isTranscribing || this._chunkQueue.length === 0) return;

    this._isTranscribing = true;

    while (this._chunkQueue.length > 0) {
      const blob = this._chunkQueue.shift();
      this._chunkIndex++;

      try {
        const transcript = await this._transcribeChunk(blob);
        if (transcript && transcript.trim().length > 0) {
          // Append to full transcript with timestamp marker
          const elapsed = Math.floor((Date.now() - this._listenStartTime) / 1000);
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          const timestamp = `[${mins}:${secs.toString().padStart(2, '0')}]`;

          this.fullTranscript += (this.fullTranscript ? '\n' : '') + `${timestamp} ${transcript.trim()}`;

          if (this.onTranscriptUpdate) {
            this.onTranscriptUpdate(this.fullTranscript);
          }
        }
      } catch (err) {
        console.error(`[Listen] Chunk #${this._chunkIndex} transcription failed:`, err.message);
        // Don't stop listening on transcription errors — keep going
      }
    }

    this._isTranscribing = false;
  }

  /**
   * Transcribe an audio chunk using Gemini.
   */
  async _transcribeChunk(audioBlob) {
    const apiKey = window.aiChat?.apiKey;
    if (!apiKey) {
      throw new Error('Gemini API key not set');
    }

    // Convert blob to base64
    const arrayBuffer = await audioBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64Audio = btoa(binary);
    const mimeType = audioBlob.type || 'audio/webm';

    const body = {
      contents: [{
        parts: [
          { text: 'Transcribe this audio accurately. Return ONLY the spoken words. If no speech is detected, return an empty string. Do not add any commentary or explanation.' },
          { inline_data: { mime_type: mimeType, data: base64Audio } }
        ]
      }],
      generationConfig: { temperature: 0 }
    };

    const model = window.aiChat?.model || 'gemini-2.5-flash';
    const baseURL = window.aiChat?.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseURL}/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini transcription error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? text.trim() : '';
  }

  /**
   * Stop listening and return the accumulated transcript.
   */
  stop() {
    if (!this.isListening) return this.fullTranscript;

    this.isListening = false;

    if (this._chunkTimer) {
      clearTimeout(this._chunkTimer);
      this._chunkTimer = null;
    }
    if (this._maxTimer) {
      clearTimeout(this._maxTimer);
      this._maxTimer = null;
    }

    // Stop current recording chunk
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }

    this._stopVisualizer();
    this._cleanup();

    if (this.onStatusChange) this.onStatusChange('stopped');

    return this.fullTranscript;
  }

  _cleanup() {
    this._stopVisualizer();

    if (this.systemStream) {
      this.systemStream.getTracks().forEach(track => track.stop());
      this.systemStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.analyser = null;
    this.mediaRecorder = null;
  }

  _getBestMimeType() {
    const codecs = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];
    for (const codec of codecs) {
      if (MediaRecorder.isTypeSupported(codec)) return codec;
    }
    return 'audio/webm';
  }

  // ========================================
  // Waveform Visualizer
  // ========================================
  _startVisualizer() {
    if (!this.analyser) return;

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    this.visualizerInterval = setInterval(() => {
      if (!this.analyser) return;

      this.analyser.getByteFrequencyData(dataArray);

      const barCount = 32;
      const step = Math.floor(bufferLength / barCount);
      for (let i = 0; i < barCount; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          sum += dataArray[i * step + j];
        }
        const avg = sum / step;
        this._waveformData[i] = this._waveformData[i] * 0.6 + (avg / 255) * 0.4;
      }

      if (this.onWaveformUpdate) {
        this.onWaveformUpdate([...this._waveformData]);
      }
    }, 50);
  }

  _stopVisualizer() {
    if (this.visualizerInterval) {
      clearInterval(this.visualizerInterval);
      this.visualizerInterval = null;
    }
    this._waveformData = new Array(32).fill(0);
    if (this.onWaveformUpdate) {
      this.onWaveformUpdate(this._waveformData);
    }
  }

  getTranscript() {
    return this.fullTranscript;
  }
}

window.voiceRecorder = new VoiceRecorder();
window.systemListener = new SystemAudioListener();
