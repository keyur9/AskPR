// content.js — injected into github.com/*/pull/* pages
// Runs SpeechRecognition AND SpeechSynthesis here — both are blocked in extension popups.
// Wrapped in a guard so re-injection on popup reopen doesn't throw duplicate declarations.

if (!window.__askprInjected) {
  window.__askprInjected = true;

  // ── PR context ──────────────────────────────────────────────────────────────
  function parsePRUrl() {
    const match = window.location.pathname.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], prNumber: match[3] };
  }

  // ── Message listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;

    if (request.type === 'GET_PR_CONTEXT') {
      const parsed = parsePRUrl();
      if (!parsed) { sendResponse({ success: false, error: 'Not a GitHub PR page' }); return; }
      chrome.runtime.sendMessage({ type: 'FETCH_PR_CONTEXT', ...parsed }, r => sendResponse(r));
      return true;
    }

    if (request.type === 'START_RECOGNITION') {
      startRecognition();
      sendResponse({ ok: true });
      return;
    }

    if (request.type === 'STOP_RECOGNITION') {
      stopRecognition();
      sendResponse({ ok: true });
      return;
    }

    if (request.type === 'SPEAK') {
      speakText(request.text);
      sendResponse({ ok: true });
      return;
    }

    if (request.type === 'STOP_SPEAKING') {
      stopSpeaking();
      sendResponse({ ok: true });
      return;
    }
  });

  // ── Speech Recognition ──────────────────────────────────────────────────────
  let recognition = null;
  let recognitionActive = false;

  function startRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      chrome.runtime.sendMessage({ type: 'RECOGNITION_ERROR', error: 'not-supported' });
      return;
    }
    if (recognitionActive) return;

    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      recognitionActive = true;
      chrome.runtime.sendMessage({ type: 'RECOGNITION_START' });
    };
    recognition.onresult = e => {
      const transcript = [...e.results].map(r => r[0].transcript).join('');
      chrome.runtime.sendMessage({ type: 'RECOGNITION_RESULT', transcript });
    };
    recognition.onerror = e => {
      recognitionActive = false;
      chrome.runtime.sendMessage({ type: 'RECOGNITION_ERROR', error: e.error });
    };
    recognition.onend = () => {
      recognitionActive = false;
      chrome.runtime.sendMessage({ type: 'RECOGNITION_END' });
    };

    try { recognition.start(); }
    catch (e) { chrome.runtime.sendMessage({ type: 'RECOGNITION_ERROR', error: e.message }); }
  }

  function stopRecognition() {
    if (recognition && recognitionActive) {
      try { recognition.stop(); } catch (_) {}
    }
  }

  // ── Speech Synthesis (TTS) ──────────────────────────────────────────────────
  // Must run here — speechSynthesis in extension popups silently fails in Chrome.

  function speakText(text) {
    if (!window.speechSynthesis) {
      chrome.runtime.sendMessage({ type: 'TTS_ERROR', error: 'not-supported' });
      return;
    }

    window.speechSynthesis.cancel(); // stop any current speech

    const clean = text
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/━+[^\n]*/g, '')
      .trim();

    const utter = new SpeechSynthesisUtterance(clean);
    utter.rate = 1.05;
    utter.pitch = 1.0;

    const pickVoice = () => {
      const voices = speechSynthesis.getVoices();
      const pick = voices.find(v =>
        ['Daniel', 'Karen', 'Samantha', 'Google US English', 'Alex'].some(n => v.name.includes(n))
      );
      if (pick) utter.voice = pick;
    };
    speechSynthesis.getVoices().length ? pickVoice()
      : speechSynthesis.addEventListener('voiceschanged', pickVoice, { once: true });

    utter.onstart  = () => chrome.runtime.sendMessage({ type: 'TTS_START' });
    utter.onend    = () => chrome.runtime.sendMessage({ type: 'TTS_END' });
    utter.onerror  = e  => chrome.runtime.sendMessage({ type: 'TTS_ERROR', error: e.error });

    window.speechSynthesis.speak(utter);
  }

  function stopSpeaking() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

} // end __askprInjected guard
