(() => {
  "use strict";

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
  const STORAGE_KEYS = {
    transcript: "lilt.transcript.v1",
    language: "lilt.language.v1",
  };
  const LOCAL_SAMPLE_RATE = 16000;
  const LOCAL_CHUNK_SAMPLES = 16000;

  const ACTIVE_PHASES = new Set(["starting", "recording", "stopping"]);
  const SEGMENTER =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;

  const elements = {};
  const state = {
    phase: "idle",
    engine: "browser",
    brave: false,
    supported: Boolean(SpeechRecognitionAPI),
    supportIssue: null,
    transcript: "",
    sessionPrefix: "",
    sessionFinal: "",
    interim: "",
    notice: null,
    micStream: null,
    audioContext: null,
    sourceNode: null,
    analyser: null,
    frequencyData: null,
    recognition: null,
    recognitionStartedAt: 0,
    finalizeTimer: null,
    restartTimer: null,
    timerInterval: null,
    elapsedMs: 0,
    barLevels: [],
    animationFrame: null,
    lastWaveDraw: 0,
    autoScroll: true,
    restoreRecordFocus: false,
    saveTimer: null,
    toastTimer: null,
    canvasContext: null,
    canvasWidth: 0,
    canvasHeight: 0,
    canvasDpr: 1,
    localAvailable: null,
    localError: "",
    localSessionId: null,
    localNode: null,
    localSink: null,
    localResampler: null,
    localChunks: [],
    localChunkLength: 0,
    localQueue: Promise.resolve(),
    localFinishing: false,
    localFailed: false,
    localHold: false,
    reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };

  function init() {
    cacheElements();
    loadPreferences();
    detectEngine();
    detectSupport();
    bindEvents();
    setupCanvas();
    updateEngineCopy();
    renderTranscript();
    syncUI();

    if (state.engine === "local") {
      warmLocalEngine();
    }

    if (state.supported) {
      window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (event) => {
        state.reduceMotion = event.matches;
      });
    }
  }

  function cacheElements() {
    const ids = [
      "headerStatus",
      "headerStatusText",
      "languageSelect",
      "recorder",
      "recorderStatus",
      "recorderHint",
      "timer",
      "waveform",
      "recordButton",
      "micState",
      "micStateText",
      "transcript",
      "transcriptBody",
      "emptyState",
      "emptyTitle",
      "emptyCopy",
      "transcriptText",
      "wordCount",
      "copyButton",
      "downloadButton",
      "clearButton",
      "toast",
      "toastMessage",
      "toastAction",
      "processingNote",
    ];

    for (const id of ids) {
      elements[id] = document.getElementById(id);
    }
  }

  function loadPreferences() {
    const savedTranscript = storageGet(STORAGE_KEYS.transcript);
    if (savedTranscript && savedTranscript.trim()) {
      state.transcript = savedTranscript;
    }

    const options = Array.from(elements.languageSelect.options).map((option) => option.value);
    const savedLanguage = storageGet(STORAGE_KEYS.language);
    let language = options.includes(savedLanguage) ? savedLanguage : inferBrowserLanguage(options);

    if (!options.includes(language)) {
      language = "en-US";
    }

    elements.languageSelect.value = language;
  }

  function inferBrowserLanguage(supportedLanguages) {
    const preferred = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language || "en-US"];

    for (const candidate of preferred) {
      if (!candidate) continue;
      if (supportedLanguages.includes(candidate)) return candidate;

      const base = candidate.split("-")[0].toLowerCase();
      const regionalMatch = supportedLanguages.find(
        (language) => language.split("-")[0].toLowerCase() === base
      );
      if (regionalMatch) return regionalMatch;
    }

    return "en-US";
  }

  function detectEngine() {
    state.brave =
      Boolean(navigator.brave && typeof navigator.brave.isBrave === "function") ||
      /\bBrave\//.test(navigator.userAgent || "");

    state.engine = SpeechRecognitionAPI && !state.brave ? "browser" : "local";
  }

  function detectSupport() {
    state.supported = true;

    if (!window.isSecureContext) {
      state.supported = false;
      state.supportIssue = {
        status: "Microphone blocked",
        hint: "Microphone access needs a secure page. Open Lilt through its local server on localhost.",
      };
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      state.supported = false;
      state.supportIssue = {
        status: "Microphone unavailable",
        hint: "This browser can’t access your microphone. Try the latest version of Chrome or Edge.",
      };
      return;
    }

    if (state.engine === "browser" && !SpeechRecognitionAPI) {
      state.supported = false;
      state.supportIssue = {
        status: "Voice input unavailable",
        hint: "Live transcription isn’t supported in this browser. Open Lilt in Chrome or Edge to record.",
      };
    }
  }

  async function warmLocalEngine() {
    try {
      const response = await fetchWithTimeout("/api/local/status", {}, 30000);
      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.available) {
        throw new Error(data.reason || "The on-device speech engine isn’t available.");
      }

      state.localAvailable = true;
      state.localError = "";
    } catch (error) {
      state.localAvailable = false;
      state.localError =
        error && error.message
          ? error.message
          : "The on-device speech engine isn’t available.";

      if (state.engine === "local") {
        if (state.phase !== "idle") {
          state.localAvailable = null;
          return;
        }

        state.supported = false;
        state.supportIssue = {
          status: "On-device engine unavailable",
          hint: `${state.localError} Restart the local server, or open it in Chrome or Edge.`,
        };
        syncUI();
        renderTranscript();
      }
    }
  }

  function updateEngineCopy() {
    if (!elements.processingNote) return;

    elements.processingNote.textContent =
      state.engine === "local"
        ? "Speech is transcribed by a local model. Your audio never leaves this computer."
        : "Speech is processed by your browser’s speech service. Your transcript stays on this device.";
  }

  function engineStatusText() {
    return state.engine === "local" ? "On-device" : "Live transcription";
  }

  function bindEvents() {
    elements.recordButton.addEventListener("click", handleRecordButton);
    elements.languageSelect.addEventListener("change", handleLanguageChange);
    elements.copyButton.addEventListener("click", copyTranscript);
    elements.downloadButton.addEventListener("click", downloadTranscript);
    elements.clearButton.addEventListener("click", clearTranscript);
    elements.transcriptText.addEventListener("input", handleTranscriptInput);
    elements.transcriptText.addEventListener("blur", handleTranscriptBlur);
    elements.transcriptText.addEventListener("paste", handleTranscriptPaste);
    elements.transcriptBody.addEventListener("scroll", handleTranscriptScroll, { passive: true });
    elements.toastAction.addEventListener("click", handleToastAction);

    window.addEventListener("pagehide", () => {
      if (state.saveTimer) {
        saveTranscript();
      }
      cleanupRecordingResources({ abortRecognition: true });
    });

    window.addEventListener("beforeunload", () => {
      cleanupRecordingResources({ abortRecognition: true });
    });
  }

  function handleLanguageChange() {
    storageSet(STORAGE_KEYS.language, elements.languageSelect.value);
  }

  async function handleRecordButton() {
    if (!state.supported) return;

    if (state.phase === "recording") {
      stopRecording();
      return;
    }

    if (state.phase === "idle") {
      await startRecording();
    }
  }

  async function startRecording() {
    const shouldRestoreFocus = document.activeElement === elements.recordButton;

    hideToast();
    clearTimeout(state.finalizeTimer);
    clearTimeout(state.restartTimer);
    state.finalizeTimer = null;
    state.restartTimer = null;
    state.notice = null;
    state.sessionPrefix = state.transcript.trimEnd();
    state.sessionFinal = "";
    state.interim = "";
    state.elapsedMs = 0;
    state.autoScroll = true;
    state.localChunks = [];
    state.localChunkLength = 0;
    state.localQueue = Promise.resolve();
    state.localFinishing = false;
    state.localFailed = false;
    state.localHold = false;
    updateTimer(0);

    if (state.engine === "local" && !localLanguageSupported()) {
      state.notice = {
        type: "error",
        status: "Language unavailable",
        hint: "On-device transcription supports English right now. Choose an English language, or open Lilt in Chrome or Edge for other languages.",
      };
      syncUI();
      renderTranscript();
      return;
    }

    if (state.engine === "local" && state.localAvailable === false) {
      state.notice = {
        type: "error",
        status: "On-device engine unavailable",
        hint:
          state.localError ||
          "Restart the local server, or open it in Chrome or Edge.",
      };
      syncUI();
      renderTranscript();
      return;
    }

    state.phase = "starting";
    syncUI();
    renderTranscript();

    let stream = null;

    try {
      if (state.engine === "local") {
        await startLocalSession();
      }

      stream = await requestMicrophone();
      state.micStream = stream;

      watchMicrophoneTrack(stream);
      await setupAudioMeter(stream);

      if (state.engine === "local") {
        markRecordingStarted();
        startLocalCapture();
      } else {
        const recognition = createRecognition();
        state.recognition = recognition;
        markRecordingStarted();
        recognition.start();
      }

      if (shouldRestoreFocus) {
        restoreRecordButtonFocus();
      }
    } catch (error) {
      const notice = describeStartError(error);
      state.phase = "idle";
      state.notice = {
        type: "error",
        status: notice.status,
        hint: notice.hint,
      };
      stopTimer();
      cleanupRecordingResources({ abortRecognition: true });
      stopWaveLoop();
      drawIdleWave();
      renderTranscript();
      syncUI();

      if (shouldRestoreFocus) {
        restoreRecordButtonFocus();
      }
    }
  }

  function markRecordingStarted() {
    state.phase = "recording";
    updateTimer(0);
    syncUI();
    renderTranscript();
    startTimer();
    startWaveLoop();
    window.setTimeout(revealTranscriptOnNarrowScreens, 220);
  }

  function localLanguageSupported() {
    const language = (elements.languageSelect.value || "en-US").toLowerCase();
    return language.startsWith("en");
  }

  function restoreRecordButtonFocus() {
    if (
      document.activeElement === document.body ||
      document.activeElement === elements.recordButton
    ) {
      elements.recordButton.focus({ preventScroll: true });
    }
  }

  function createRecognition() {
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = elements.languageSelect.value;

    recognition.onstart = () => {
      if (state.recognition !== recognition) return;

      if (state.phase !== "recording" && state.phase !== "stopping") {
        try {
          recognition.abort();
        } catch {
          // The recognizer is already inactive.
        }
      }
    };

    recognition.onresult = (event) => {
      if (state.recognition !== recognition) return;
      handleRecognitionResult(event);
    };

    recognition.onerror = (event) => {
      if (state.recognition !== recognition) return;
      handleRecognitionError(event);
    };

    recognition.onend = () => {
      if (state.recognition !== recognition) return;
      handleRecognitionEnd(recognition);
    };

    return recognition;
  }

  function handleRecognitionResult(event) {
    if (state.phase !== "recording" && state.phase !== "stopping") return;

    let interim = "";
    let gotFinal = false;

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternative = result && result[0];
      if (!alternative) continue;

      const text = alternative.transcript || "";
      if (result.isFinal) {
        state.sessionFinal = appendWords(state.sessionFinal, text);
        gotFinal = true;
      } else {
        interim = appendWords(interim, text);
      }
    }

    state.interim = interim.trim();

    if (gotFinal) {
      state.notice = null;
    }

    renderTranscript();
  }

  function handleRecognitionError(event) {
    const code = event.error;

    if (code === "no-speech" || code === "aborted") {
      return;
    }

    if (state.phase === "stopping") {
      return;
    }

    if (
      (code === "network" || code === "service-not-allowed") &&
      state.engine === "browser" &&
      localLanguageSupported()
    ) {
      switchToLocalMidRecording();
      return;
    }

    let message;

    switch (code) {
      case "not-allowed":
        message = "Microphone access was blocked. Allow it in your browser’s site settings, then try again.";
        break;
      case "service-not-allowed":
        message = "Speech recognition is blocked for this page. Check your browser’s site settings.";
        break;
      case "audio-capture":
        message = "No microphone is available. Connect one and try again.";
        break;
      case "network":
        message = "Speech recognition needs an internet connection. Check your connection and try again.";
        break;
      case "language-not-supported":
        message = "This language isn’t available for speech recognition. Pick another from the language menu.";
        break;
      default:
        message = "Speech recognition stopped unexpectedly. Give it another try.";
        break;
    }

    failRecording("Recording stopped", message);
  }

  function handleRecognitionEnd(recognition) {
    if (state.phase === "recording") {
      commitInterimToFinal();
      renderTranscript();
      scheduleRecognitionRestart(recognition);
      return;
    }

    if (state.phase === "stopping") {
      finalizeSession();
    }
  }

  function scheduleRecognitionRestart(recognition) {
    clearTimeout(state.restartTimer);

    state.restartTimer = window.setTimeout(() => {
      if (state.phase !== "recording" || state.recognition !== recognition) return;

      try {
        recognition.start();
      } catch (error) {
        if (error && error.name === "InvalidStateError") return;
        failRecording("Recognition stopped", "Live speech recognition couldn’t restart. Give it another try.");
      }
    }, 150);
  }

  /* On-device transcription */

  function localSetupError(message) {
    const error = new Error(message);
    error.name = "LocalSetupError";
    return error;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    if (typeof AbortController !== "function") {
      return fetch(url, options);
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function startLocalSession() {
    if (state.localSessionId) return;

    let response;

    try {
      response = await fetchWithTimeout("/api/local/start", { method: "POST" }, 30000);
    } catch {
      throw localSetupError(
        "The on-device engine didn’t respond. Make sure Lilt is still running and try again."
      );
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.id) {
      throw localSetupError(
        data.reason || "The on-device engine couldn’t start. Restart Lilt and try again."
      );
    }

    state.localSessionId = data.id;
    state.localAvailable = true;
    state.localError = "";
  }

  async function switchToLocalMidRecording() {
    if (state.phase !== "recording") return;

    const recognition = state.recognition;
    state.recognition = null;

    clearTimeout(state.restartTimer);
    state.restartTimer = null;

    commitInterimToFinal();
    state.interim = "";
    renderTranscript();

    if (recognition) {
      try {
        recognition.abort();
      } catch {
        // The browser recognizer is already inactive.
      }
    }

    showToast("Browser speech couldn’t connect. Starting on-device transcription…");

    state.engine = "local";
    state.localHold = true;
    state.localFailed = false;
    state.localChunks = [];
    state.localChunkLength = 0;
    updateEngineCopy();

    try {
      startLocalCapture();
    } catch (error) {
      state.localHold = false;
      failRecording(
        "Recording stopped",
        (error && error.message) ||
          "This browser can’t capture audio for on-device transcription."
      );
      return;
    }

    state.phase = "starting";
    syncUI();

    try {
      await startLocalSession();
    } catch (error) {
      state.localHold = false;
      stopLocalCapture();
      state.localChunks = [];
      state.localChunkLength = 0;
      state.phase = "recording";
      failRecording(
        "Recording stopped",
        (error && error.message) ||
          "Browser speech failed and the on-device engine isn’t available. Try again."
      );
      return;
    }

    if (state.phase !== "starting") {
      state.localHold = false;
      stopLocalCapture();
      state.localChunks = [];
      state.localChunkLength = 0;

      const sessionId = state.localSessionId;
      state.localSessionId = null;

      if (sessionId) {
        const cancel = fetch(`/api/local/${sessionId}/cancel`, {
          method: "POST",
          keepalive: true,
        });
        if (cancel && typeof cancel.catch === "function") {
          cancel.catch(() => {});
        }
      }
      return;
    }

    state.localAvailable = true;
    state.phase = "recording";
    state.localHold = false;
    flushLocalPcm();
    syncUI();
    showToast("Using on-device transcription.");
  }

  function startLocalCapture() {
    const context = state.audioContext;
    const source = state.sourceNode;

    if (!context || !source) {
      throw localSetupError(
        "This browser couldn’t open an audio channel for on-device transcription."
      );
    }

    const createProcessor = context.createScriptProcessor || context.createJavaScriptNode;
    if (typeof createProcessor !== "function") {
      throw localSetupError(
        "This browser can’t capture audio for on-device transcription. Try Chrome or Edge."
      );
    }

    const node = createProcessor.call(context, 4096, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;

    node.onaudioprocess = (event) => {
      if (state.localFinishing || state.localFailed) return;
      handleLocalAudio(event.inputBuffer.getChannelData(0));
    };

    state.localNode = node;
    state.localSink = sink;
    state.localResampler = createResampler(context.sampleRate, LOCAL_SAMPLE_RATE);

    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
  }

  function createResampler(inputRate, outputRate) {
    let remainder = new Float32Array(0);
    let position = 0;
    const ratio = inputRate / outputRate;

    return {
      process(input) {
        if (!input || !input.length) return new Int16Array(0);

        const buffer = new Float32Array(remainder.length + input.length);
        buffer.set(remainder, 0);
        buffer.set(input, remainder.length);

        const estimated = Math.max(0, Math.ceil((buffer.length - position) / ratio));
        const output = new Int16Array(estimated);
        let outIndex = 0;
        let pos = position;

        while (pos + 1 < buffer.length && outIndex < output.length) {
          const index = Math.floor(pos);
          const fraction = pos - index;
          const a = buffer[index];
          const b = buffer[index + 1];
          const interpolated = a + (b - a) * fraction;

          const start = Math.max(0, index - 1);
          const end = Math.min(buffer.length - 1, index + 2);
          let sum = 0;
          for (let cursor = start; cursor <= end; cursor += 1) {
            sum += buffer[cursor];
          }

          const smoothed = sum / (end - start + 1);
          const value = Math.max(-1, Math.min(1, (interpolated + smoothed) / 2));
          output[outIndex] = Math.round(value * 32767);
          outIndex += 1;
          pos += ratio;
        }

        const consumed = Math.floor(pos);
        remainder = buffer.slice(consumed);
        position = pos - consumed;

        return outIndex === output.length ? output : output.slice(0, outIndex);
      },
    };
  }

  function handleLocalAudio(input) {
    if (!state.localResampler) return;

    const pcm = state.localResampler.process(input);
    if (!pcm.length) return;

    state.localChunks.push(pcm);
    state.localChunkLength += pcm.length;

    if (state.localChunkLength >= LOCAL_CHUNK_SAMPLES && !state.localHold) {
      flushLocalPcm();
    }
  }

  function flushLocalPcm() {
    if (!state.localChunkLength || state.localHold) return;

    const merged = new Int16Array(state.localChunkLength);
    let offset = 0;

    for (const chunk of state.localChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    state.localChunks = [];
    state.localChunkLength = 0;
    sendLocalAudio(merged);
  }

  function sendLocalAudio(samples) {
    const sessionId = state.localSessionId;
    if (!sessionId || state.localFailed) return;

    const body = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    );

    state.localQueue = state.localQueue
      .then(async () => {
        if (state.localSessionId !== sessionId || state.localFailed) return;

        let response;

        try {
          response = await fetchWithTimeout(
            `/api/local/${sessionId}/audio`,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body,
            },
            8000
          );
        } catch {
          throw new Error("The on-device transcriber stopped responding.");
        }

        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("The on-device recording session ended unexpectedly.");
          }
          throw new Error("The on-device transcriber couldn’t process the audio.");
        }

        if (state.localSessionId !== sessionId || state.localFailed) return;

        const data = await response.json();
        handleLocalResult(data);
      })
      .catch((error) => {
        if (state.localSessionId !== sessionId) return;
        handleLocalFailure(error);
      });
  }

  function handleLocalResult(data) {
    if (!data || state.localFailed) return;
    if (state.phase !== "recording" && state.phase !== "stopping") return;

    const finalText = typeof data.final === "string" ? data.final.trim() : "";
    const partialText = typeof data.partial === "string" ? data.partial.trim() : "";

    if (finalText) {
      state.sessionFinal = appendWords(state.sessionFinal, finalText);
    }

    state.interim = partialText;

    if (finalText || partialText) {
      state.notice = null;
    }

    renderTranscript();
  }

  function handleLocalFailure(error) {
    if (state.localFailed) return;
    if (state.phase !== "recording" && state.phase !== "stopping") return;

    state.localFailed = true;

    if (state.phase === "stopping") return;

    failRecording(
      "Transcription stopped",
      (error && error.message) ||
        "The on-device transcriber stopped unexpectedly. Give it another try."
    );
  }

  function stopLocalCapture() {
    const node = state.localNode;
    const sink = state.localSink;
    state.localNode = null;
    state.localSink = null;
    state.localResampler = null;

    if (node) {
      node.onaudioprocess = null;
      if (state.sourceNode) {
        try {
          state.sourceNode.disconnect(node);
        } catch {
          // The capture node is already detached.
        }
      }
      try {
        node.disconnect();
      } catch {
        // The capture node is already disconnected.
      }
    }

    if (sink) {
      try {
        sink.disconnect();
      } catch {
        // The silent output node is already disconnected.
      }
    }
  }

  async function stopLocalEngine() {
    state.localFinishing = true;
    stopLocalCapture();
    flushLocalPcm();

    const sessionId = state.localSessionId;

    try {
      await state.localQueue;
    } catch {
      // Each queued request reports its own failure.
    }

    if (!sessionId) {
      state.localFinishing = false;
      return;
    }

    try {
      const response = await fetchWithTimeout(
        `/api/local/${sessionId}/finish`,
        { method: "POST" },
        10000
      );

      if (!response.ok) throw new Error("Local transcription did not finish.");

      const data = await response.json();
      const finalText = typeof data.text === "string" ? data.text.trim() : "";

      if (finalText) {
        state.sessionFinal = appendWords(state.sessionFinal, finalText);
        state.interim = "";
        state.notice = null;
      }
    } catch {
      if (!state.sessionFinal.trim() && !state.interim.trim()) {
        state.notice = {
          type: "error",
          status: "Couldn’t finish transcript",
          hint: "The on-device engine didn’t return the last words. Give it another try.",
        };
      }
    } finally {
      state.localSessionId = null;
      state.localFinishing = false;
    }
  }

  function stopRecording() {
    if (state.phase !== "recording") return;

    state.restoreRecordFocus = document.activeElement === elements.recordButton;
    state.phase = "stopping";
    stopTimer();
    syncUI();
    renderTranscript();

    if (state.engine === "local") {
      stopLocalEngine()
        .catch(() => {})
        .finally(() => finalizeSession());
      return;
    }

    clearTimeout(state.restartTimer);
    state.restartTimer = null;

    const recognition = state.recognition;
    let stopSucceeded = false;

    if (recognition) {
      try {
        recognition.stop();
        stopSucceeded = true;
      } catch {
        stopSucceeded = false;
      }
    }

    state.finalizeTimer = window.setTimeout(
      finalizeSession,
      stopSucceeded ? 1600 : 250
    );
  }

  function finalizeSession() {
    if (state.phase === "idle") return;

    clearTimeout(state.finalizeTimer);
    clearTimeout(state.restartTimer);
    state.finalizeTimer = null;
    state.restartTimer = null;

    stopTimer();
    commitInterimToFinal();

    const prefix = state.sessionPrefix.trimEnd();
    const spoken = state.sessionFinal.trim();
    const hadNewSpeech = Boolean(spoken);
    const explicitNotice = state.notice;

    if (hadNewSpeech) {
      state.transcript = prefix
        ? `${prefix}\n\n${spoken}`
        : spoken;
    }

    state.phase = "idle";
    state.sessionPrefix = "";
    state.sessionFinal = "";
    state.interim = "";

    if (!hadNewSpeech && !explicitNotice) {
      state.notice = {
        type: "no-speech",
        status: prefix ? "No new words" : "No words captured",
        hint: prefix
          ? "Try again whenever you’re ready to add to your transcript."
          : "We didn’t catch anything. Try again, a little closer to the microphone.",
      };
    } else {
      state.notice = explicitNotice;
    }

    cleanupRecordingResources({ abortRecognition: true });
    stopWaveLoop();
    drawIdleWave();

    if (hadNewSpeech) {
      saveTranscript();
    }

    renderTranscript();
    syncUI();

    if (state.restoreRecordFocus) {
      state.restoreRecordFocus = false;
      restoreRecordButtonFocus();
    }
  }

  function failRecording(status, hint) {
    if (state.phase !== "recording" && state.phase !== "stopping") return;

    state.notice = {
      type: "error",
      status,
      hint,
    };

    stopTimer();
    finalizeSession();
  }

  function commitInterimToFinal() {
    if (state.interim.trim()) {
      state.sessionFinal = appendWords(state.sessionFinal, state.interim);
      state.interim = "";
    }
  }

  async function requestMicrophone() {
    const preferredConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };

    try {
      return await navigator.mediaDevices.getUserMedia(preferredConstraints);
    } catch (error) {
      if (error && (error.name === "OverconstrainedError" || error.name === "TypeError")) {
        return navigator.mediaDevices.getUserMedia({ audio: true });
      }
      throw error;
    }
  }

  function watchMicrophoneTrack(stream) {
    const [track] = stream.getAudioTracks();
    if (!track) return;

    track.addEventListener("ended", () => {
      if (state.phase === "recording") {
        failRecording(
          "Microphone disconnected",
          "The microphone lost its connection. Reconnect it and start again."
        );
      }
    });
  }

  async function setupAudioMeter(stream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    try {
      const audioContext = new AudioContextClass();
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const sourceNode = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.76;
      sourceNode.connect(analyser);

      state.audioContext = audioContext;
      state.sourceNode = sourceNode;
      state.analyser = analyser;
      state.frequencyData = new Uint8Array(analyser.frequencyBinCount);
    } catch (error) {
      console.warn("Audio meter unavailable:", error);
      state.analyser = null;
      state.frequencyData = null;
    }
  }

  function cleanupRecordingResources({ abortRecognition = false } = {}) {
    clearTimeout(state.finalizeTimer);
    clearTimeout(state.restartTimer);
    state.finalizeTimer = null;
    state.restartTimer = null;

    if (state.localSessionId) {
      const sessionId = state.localSessionId;
      state.localSessionId = null;

      if (!state.localFinishing) {
        const cancel = fetch(`/api/local/${sessionId}/cancel`, {
          method: "POST",
          keepalive: true,
        });
        if (cancel && typeof cancel.catch === "function") {
          cancel.catch(() => {});
        }
      }
    }

    stopLocalCapture();

    state.localChunks = [];
    state.localChunkLength = 0;
    state.localQueue = Promise.resolve();
    state.localFailed = false;
    state.localFinishing = false;
    state.localHold = false;

    const recognition = state.recognition;
    state.recognition = null;

    if (abortRecognition && recognition) {
      try {
        recognition.abort();
      } catch {
        // The recognizer is already inactive.
      }
    }

    if (state.sourceNode) {
      try {
        state.sourceNode.disconnect();
      } catch {
        // The audio graph is already disconnected.
      }
      state.sourceNode = null;
    }

    if (state.audioContext) {
      const audioContext = state.audioContext;
      state.audioContext = null;
      try {
        const closeResult = audioContext.close();
        if (closeResult && typeof closeResult.catch === "function") {
          closeResult.catch(() => {});
        }
      } catch {
        // The audio context is already closed.
      }
    }

    state.analyser = null;
    state.frequencyData = null;

    if (state.micStream) {
      for (const track of state.micStream.getTracks()) {
        track.stop();
      }
      state.micStream = null;
    }
  }

  function describeStartError(error) {
    const name = error && error.name;

    switch (name) {
      case "LocalSetupError":
        return {
          status: "On-device engine unavailable",
          hint: error.message,
        };
      case "NotAllowedError":
      case "PermissionDeniedError":
      case "SecurityError":
        return {
          status: "Microphone blocked",
          hint: "Allow microphone access in your browser’s site settings, then try again.",
        };
      case "NotFoundError":
      case "DevicesNotFoundError":
        return {
          status: "No microphone found",
          hint: "Connect a microphone and try recording again.",
        };
      case "NotReadableError":
      case "TrackStartError":
        return {
          status: "Microphone is busy",
          hint: "Another app may be using your microphone. Close it and try again.",
        };
      case "InvalidStateError":
        return {
          status: "Couldn’t start recording",
          hint: "Refresh the page and give the microphone another try.",
        };
      default:
        return {
          status: "Couldn’t start recording",
          hint: "Your microphone couldn’t start. Check its connection and try again.",
        };
    }
  }

  function revealTranscriptOnNarrowScreens() {
    if (state.phase !== "recording") return;
    if (!window.matchMedia("(max-width: 820px)").matches) return;

    const transcriptTop = elements.transcript.getBoundingClientRect().top;
    const transcriptRoom = window.innerHeight - transcriptTop;
    if (transcriptRoom >= 330) return;

    const recorderTop = elements.recorder.getBoundingClientRect().top + window.scrollY;
    const target = Math.max(0, recorderTop - 12);

    if (target - window.scrollY < 24) return;

    window.scrollTo({
      top: target,
      behavior: state.reduceMotion ? "auto" : "smooth",
    });
  }

  function startTimer() {
    stopTimer(false, true);
    state.recognitionStartedAt = performance.now();
    state.elapsedMs = 0;
    updateTimer(0);

    state.timerInterval = window.setInterval(() => {
      if (!state.recognitionStartedAt) return;
      state.elapsedMs = performance.now() - state.recognitionStartedAt;
      updateTimer(state.elapsedMs);
    }, 250);
  }

  function stopTimer(updateDisplay = true, resetStart = false) {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }

    if (state.recognitionStartedAt) {
      state.elapsedMs = performance.now() - state.recognitionStartedAt;
      state.recognitionStartedAt = 0;
    }

    if (resetStart) {
      state.elapsedMs = 0;
    }

    if (updateDisplay) {
      updateTimer(state.elapsedMs);
    }
  }

  function updateTimer(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    elements.timer.textContent = `${minutes}:${seconds}`;
    elements.timer.setAttribute("datetime", `PT${totalSeconds}S`);
  }

  function syncUI() {
    const isIdle = state.phase === "idle";
    const isRecording = state.phase === "recording";
    const isActive = ACTIVE_PHASES.has(state.phase);
    const hasText = Boolean(state.transcript.trim());
    const disabledDuringTransition = state.phase === "starting" || state.phase === "stopping";

    elements.recorder.dataset.state = state.phase;
    elements.recorder.dataset.tone = state.notice ? "notice" : "none";
    elements.transcriptText.lang = elements.languageSelect.value;

    elements.recordButton.disabled = !state.supported || disabledDuringTransition;
    elements.recordButton.setAttribute("aria-pressed", String(isRecording));
    elements.recordButton.setAttribute(
      "aria-label",
      isRecording
        ? "Stop recording"
        : state.phase === "starting"
          ? state.engine === "local"
            ? "Preparing on-device transcription"
            : "Connecting to microphone"
          : state.phase === "stopping"
            ? "Finishing recording"
            : "Start recording"
    );

    if (disabledDuringTransition) {
      elements.recordButton.setAttribute("aria-busy", "true");
    } else {
      elements.recordButton.removeAttribute("aria-busy");
    }

    elements.languageSelect.disabled = !state.supported || !isIdle;

    elements.copyButton.disabled = !isIdle || !hasText;
    elements.downloadButton.disabled = !isIdle || !hasText;
    elements.clearButton.disabled = !isIdle || !hasText;

    elements.micState.classList.toggle(
      "is-live",
      state.phase === "recording" || state.phase === "stopping"
    );

    if (!state.supported) {
      elements.recorderStatus.textContent = state.supportIssue.status;
      elements.recorderHint.textContent = state.supportIssue.hint;
      elements.micStateText.textContent = "Mic off";
      setHeaderStatus(
        "unsupported",
        state.engine === "local" ? "On-device unavailable" : "Speech unavailable"
      );
      return;
    }

    if (state.phase === "starting") {
      elements.recorderStatus.textContent =
        state.engine === "local" ? "Preparing engine" : "Connecting";
      elements.recorderHint.textContent =
        state.engine === "local"
          ? "Getting the microphone and on-device engine ready. The first take can take a moment."
          : "Allow microphone access in the browser prompt to begin.";
      elements.micStateText.textContent = "Requesting mic";
      setHeaderStatus(
        "starting",
        state.engine === "local" ? "Preparing on-device" : "Connecting"
      );
      return;
    }

    if (isRecording) {
      elements.recorderStatus.textContent = "Listening";
      elements.recorderHint.textContent = "Speak naturally. Press stop when you’re finished.";
      elements.micStateText.textContent = "Mic live";
      setHeaderStatus("recording", "Listening now");
      return;
    }

    if (state.phase === "stopping") {
      elements.recorderStatus.textContent = "Finishing up";
      elements.recorderHint.textContent = "One moment while we catch your last words.";
      elements.micStateText.textContent = "Mic live";
      setHeaderStatus("idle", "Finishing up");
      return;
    }

    elements.micStateText.textContent = "Mic off";

    if (state.notice) {
      elements.recorderStatus.textContent = state.notice.status;
      elements.recorderHint.textContent = state.notice.hint;
      setHeaderStatus("idle", engineStatusText());
      return;
    }

    if (hasText) {
      elements.recorderStatus.textContent = "Transcript ready";
      elements.recorderHint.textContent = "Press record to add more whenever you’re ready.";
    } else {
      elements.recorderStatus.textContent = "Ready to record";
      elements.recorderHint.textContent = "Press record and start talking.";
    }

    setHeaderStatus("idle", engineStatusText());
  }

  function setHeaderStatus(status, text) {
    elements.headerStatus.dataset.state = status;
    elements.headerStatusText.textContent = text;
  }

  function renderTranscript() {
    const isActive = ACTIVE_PHASES.has(state.phase);

    if (isActive) {
      renderLiveTranscript();
      return;
    }

    const text = state.transcript;
    const hasText = Boolean(text.trim());

    if (!hasText) {
      showEmptyState();
      elements.transcriptText.hidden = true;
      elements.transcriptText.setAttribute("contenteditable", "false");
      elements.transcriptText.setAttribute("aria-readonly", "true");
      elements.transcriptText.textContent = "";
      updateWordCount("");
      return;
    }

    elements.emptyState.hidden = true;
    elements.transcriptText.hidden = false;
    elements.transcriptText.setAttribute("contenteditable", "true");
    elements.transcriptText.setAttribute("aria-readonly", "false");
    elements.transcriptText.replaceChildren(document.createTextNode(text));
    updateWordCount(text);
  }

  function renderLiveTranscript() {
    const prefix = state.sessionPrefix.trimEnd();
    const spoken = state.sessionFinal.trim();
    const interim = state.interim.trim();
    const hasSpeech = Boolean(spoken || interim);

    if (!prefix && !hasSpeech) {
      showEmptyState();
      elements.transcriptText.hidden = true;
      elements.transcriptText.setAttribute("contenteditable", "false");
      elements.transcriptText.setAttribute("aria-readonly", "true");
      elements.transcriptText.textContent = "";
      updateWordCount("");
      return;
    }

    const baseText = prefix
      ? `${prefix}${hasSpeech ? "\n\n" : ""}${spoken}`
      : spoken;

    elements.emptyState.hidden = true;
    elements.transcriptText.hidden = false;
    elements.transcriptText.setAttribute("contenteditable", "false");
    elements.transcriptText.setAttribute("aria-readonly", "true");

    const needsSpace = Boolean(interim && baseText && !/\s$/.test(baseText));
    const beforeInterim = `${baseText}${needsSpace ? " " : ""}`;

    const textNode = document.createTextNode(beforeInterim);
    const interimSpan = document.createElement("span");
    interimSpan.className = "live-interim";
    interimSpan.textContent = interim;

    elements.transcriptText.replaceChildren(textNode, interimSpan);
    updateWordCount(`${beforeInterim}${interim}`);
    scrollTranscriptToEnd();
  }

  function showEmptyState() {
    const content = getEmptyStateContent();
    elements.emptyState.hidden = false;
    elements.emptyTitle.innerHTML = content.title;
    elements.emptyCopy.textContent = content.copy;
  }

  function getEmptyStateContent() {
    if (!state.supported) {
      return {
        title: "Live text is <em>unavailable.</em>",
        copy: state.supportIssue.hint,
      };
    }

    if (state.phase === "starting") {
      return {
        title: "One quick <em>thing.</em>",
        copy:
          state.engine === "local"
            ? "The on-device engine is getting ready. Your words will appear in a moment."
            : "Allow microphone access in the browser prompt to start recording.",
      };
    }

    if (state.phase === "recording") {
      return {
        title: 'Listening<span class="listening-dots"></span>',
        copy: "Speak naturally. Your words will appear here as you go.",
      };
    }

    if (state.phase === "stopping") {
      return {
        title: "Just a <em>moment.</em>",
        copy: "We’re gathering your last words.",
      };
    }

    if (state.notice && state.notice.type === "no-speech") {
      return {
        title: "A quiet <em>take.</em>",
        copy: "We didn’t catch anything. Try again, a little closer to the microphone.",
      };
    }

    return {
      title: "Nothing to read. <em>Yet.</em>",
      copy: "Press record and your words will appear here. You can edit every line afterward.",
    };
  }

  function updateWordCount(text) {
    const count = countWords(text);
    elements.wordCount.textContent = `${count} ${count === 1 ? "word" : "words"}`;
  }

  function countWords(text) {
    const clean = (text || "").trim();
    if (!clean) return 0;

    if (SEGMENTER) {
      let count = 0;
      for (const segment of SEGMENTER.segment(clean)) {
        if (segment.isWordLike) count += 1;
      }
      return count;
    }

    return clean.split(/\s+/).filter(Boolean).length;
  }

  function appendWords(base, addition) {
    const next = (addition || "").trim();
    if (!next) return (base || "").trim();
    if (!base) return next;
    return `${base.trim()} ${next}`;
  }

  function scrollTranscriptToEnd() {
    if (!state.autoScroll) return;

    window.requestAnimationFrame(() => {
      elements.transcriptBody.scrollTop = elements.transcriptBody.scrollHeight;
    });
  }

  function handleTranscriptScroll() {
    if (!ACTIVE_PHASES.has(state.phase)) return;

    const body = elements.transcriptBody;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    state.autoScroll = distanceFromBottom < 64;
  }

  function handleTranscriptInput() {
    if (state.phase !== "idle") return;

    const text = elements.transcriptText.innerText.replace(/\u00a0/g, " ");
    state.transcript = text;
    state.notice = null;

    if (!text.trim()) {
      state.transcript = "";
      renderTranscript();
      syncUI();
      saveTranscript();
      return;
    }

    updateWordCount(text);
    syncUI();
    scheduleSave();
  }

  function handleTranscriptBlur() {
    if (state.phase !== "idle") return;
    if (elements.transcriptText.hidden) return;

    state.transcript = elements.transcriptText.innerText.replace(/\u00a0/g, " ");
    saveTranscript();
  }

  function handleTranscriptPaste(event) {
    if (state.phase !== "idle") {
      event.preventDefault();
      return;
    }

    const pastedText = event.clipboardData && event.clipboardData.getData("text/plain");
    if (!pastedText) return;

    event.preventDefault();

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    selection.deleteFromDocument();
    const range = selection.getRangeAt(0);
    const textNode = document.createTextNode(pastedText);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    elements.transcriptText.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(saveTranscript, 350);
  }

  function saveTranscript() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;

    if (state.transcript && state.transcript.trim()) {
      storageSet(STORAGE_KEYS.transcript, state.transcript);
    } else {
      storageRemove(STORAGE_KEYS.transcript);
    }
  }

  function getTranscriptForAction() {
    if (state.phase !== "idle") return "";
    return (state.transcript || "").trim();
  }

  async function copyTranscript() {
    const text = getTranscriptForAction();
    if (!text) return;

    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(text);
      showToast("Transcript copied to clipboard.");
    } catch {
      const copied = copyTextFallback(text);
      showToast(
        copied
          ? "Transcript copied to clipboard."
          : "Couldn’t copy automatically. Select the text and copy it manually."
      );
    }
  }

  function copyTextFallback(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }

    area.remove();
    return copied;
  }

  function downloadTranscript() {
    const text = getTranscriptForAction();
    if (!text) return;

    const blob = new Blob([`${text}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `transcript-${formatFilenameDate(new Date())}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    showToast("Transcript downloaded.");
  }

  function formatFilenameDate(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
    ].join("-") + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  function clearTranscript() {
    if (state.phase !== "idle") return;

    const previousText = state.transcript;
    if (!previousText.trim()) return;

    state.transcript = "";
    state.notice = null;
    stopTimer();
    state.elapsedMs = 0;
    updateTimer(0);
    saveTranscript();
    renderTranscript();
    syncUI();

    showToast("Transcript cleared.", {
      actionLabel: "Undo",
      duration: 6000,
      onAction: () => {
        if (state.phase !== "idle") return;
        state.transcript = previousText;
        state.notice = null;
        saveTranscript();
        renderTranscript();
        syncUI();
        showToast("Transcript restored.");
        elements.clearButton.focus();
      },
    });
  }

  function showToast(message, { actionLabel = "", duration = 3600, onAction = null } = {}) {
    clearTimeout(state.toastTimer);

    elements.toastMessage.textContent = message;
    elements.toastAction.hidden = !(actionLabel && onAction);
    elements.toastAction.textContent = actionLabel || "Undo";
    state.toastAction = onAction || null;

    elements.toast.classList.add("is-visible");

    state.toastTimer = window.setTimeout(hideToast, duration);
  }

  function hideToast() {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
    state.toastAction = null;
    elements.toast.classList.remove("is-visible");
  }

  function handleToastAction() {
    const action = state.toastAction;
    if (!action) return;
    hideToast();
    action();
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // A full or unavailable storage area should not interrupt recording.
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage is unavailable.
    }
  }

  /* Waveform */

  function setupCanvas() {
    const context = elements.waveform.getContext("2d");
    if (!context) return;

    state.canvasContext = context;

    const resizeCanvas = () => {
      const rect = elements.waveform.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      state.canvasWidth = rect.width;
      state.canvasHeight = rect.height;
      state.canvasDpr = dpr;
      elements.waveform.width = Math.max(1, Math.round(rect.width * dpr));
      elements.waveform.height = Math.max(1, Math.round(rect.height * dpr));
      state.barLevels = [];

      if (ACTIVE_PHASES.has(state.phase)) {
        drawWave(performance.now(), true);
      } else {
        drawIdleWave();
      }
    };

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(resizeCanvas).observe(elements.waveform);
    } else {
      window.addEventListener("resize", resizeCanvas);
    }

    resizeCanvas();
  }

  function startWaveLoop() {
    stopWaveLoop();
    state.lastWaveDraw = 0;

    const tick = (time) => {
      if (!ACTIVE_PHASES.has(state.phase)) return;

      const interval = state.reduceMotion ? 120 : 32;
      if (time - state.lastWaveDraw >= interval) {
        state.lastWaveDraw = time;
        drawWave(time, true);
      }

      state.animationFrame = window.requestAnimationFrame(tick);
    };

    state.animationFrame = window.requestAnimationFrame(tick);
  }

  function stopWaveLoop() {
    if (state.animationFrame) {
      window.cancelAnimationFrame(state.animationFrame);
      state.animationFrame = null;
    }
  }

  function drawIdleWave() {
    state.barLevels = [];
    drawWave(performance.now(), false);
  }

  function drawWave(time, active) {
    const context = state.canvasContext;
    const width = state.canvasWidth;
    const height = state.canvasHeight;

    if (!context || !width || !height) return;

    const dpr = state.canvasDpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const count = Math.max(32, Math.min(58, Math.round(width / 8.6)));
    const gap = Math.max(4, Math.min(7, width / 100));
    const barWidth = Math.max(2, (width - gap * (count - 1)) / count);
    const maxBarHeight = height * 0.74;
    const centerY = height / 2;
    const centerIndex = (count - 1) / 2;

    if (active && state.analyser && state.frequencyData) {
      state.analyser.getByteFrequencyData(state.frequencyData);
    }

    if (!state.barLevels.length || state.barLevels.length !== count) {
      state.barLevels = Array.from({ length: count }, (_, index) =>
        getStaticBarHeight(index, count)
      );
    }

    const gradient = context.createLinearGradient(0, 0, width, 0);

    if (active) {
      gradient.addColorStop(0, "rgba(246, 239, 227, 0.2)");
      gradient.addColorStop(0.18, "rgba(246, 239, 227, 0.64)");
      gradient.addColorStop(0.44, "rgba(246, 239, 227, 0.88)");
      gradient.addColorStop(0.49, "rgba(255, 138, 112, 0.95)");
      gradient.addColorStop(0.51, "rgba(255, 138, 112, 0.95)");
      gradient.addColorStop(0.56, "rgba(246, 239, 227, 0.88)");
      gradient.addColorStop(0.82, "rgba(246, 239, 227, 0.64)");
      gradient.addColorStop(1, "rgba(246, 239, 227, 0.2)");
    } else {
      gradient.addColorStop(0, "rgba(246, 239, 227, 0.1)");
      gradient.addColorStop(0.5, "rgba(246, 239, 227, 0.26)");
      gradient.addColorStop(1, "rgba(246, 239, 227, 0.1)");
    }

    context.fillStyle = gradient;

    const usableBins = state.frequencyData
      ? Math.max(8, Math.floor(state.frequencyData.length * 0.62))
      : 0;

    for (let index = 0; index < count; index += 1) {
      let target;

      if (active) {
        const distance = Math.abs(index - centerIndex) / Math.max(centerIndex, 1);
        const taper = 0.36 + 0.64 * Math.sin((Math.PI * (index + 0.5)) / count);

        if (state.frequencyData && usableBins) {
          const bin = Math.min(
            state.frequencyData.length - 1,
            Math.floor(Math.pow(distance, 1.45) * usableBins)
          );
          const amplitude = state.frequencyData[bin] / 255;
          target = 0.045 + Math.pow(amplitude, 0.74) * 0.94 * taper;
        } else {
          target =
            0.1 +
            0.65 *
              Math.sin((Math.PI * (index + 0.5)) / count) *
              Math.abs(Math.sin(time / 260 + index * 0.67));
        }
      } else {
        target = getStaticBarHeight(index, count);
      }

      const easing = active ? 0.26 : 0.5;
      state.barLevels[index] += (target - state.barLevels[index]) * easing;

      const barHeight = Math.max(2.5, Math.min(maxBarHeight, state.barLevels[index] * maxBarHeight));
      const x = index * (barWidth + gap);
      const y = centerY - barHeight / 2;

      drawRoundedBar(context, x, y, barWidth, barHeight, barWidth / 2);
    }
  }

  function getStaticBarHeight(index, count) {
    const position = (index + 0.5) / count;
    const envelope = Math.pow(Math.sin(Math.PI * position), 1.25);
    const rhythm =
      0.48 +
      0.3 * Math.abs(Math.sin(index * 0.72 + 0.9)) +
      0.22 * Math.abs(Math.sin(index * 0.21 + 2.1));

    return 0.055 + envelope * rhythm * 0.52;
  }

  function drawRoundedBar(context, x, y, width, height, radius) {
    context.beginPath();

    if (typeof context.roundRect === "function") {
      context.roundRect(x, y, width, height, radius);
    } else {
      context.rect(x, y, width, height);
    }

    context.fill();
  }

  init();
})();
