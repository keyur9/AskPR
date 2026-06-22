// popup.js — AskPR

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────────────────
let prContext = null;
let conversationHistory = [];
let settings = {
  provider: 'anthropic',
  anthropic: { key: '', model: 'claude-sonnet-4-6' },
  openai:    { key: '', model: 'gpt-4o' }
};
let currentMode = 'voice';
let isSpeaking = false;
let isListening = false;
let currentTabId = null;
let sessionKey = null;
let liveTranscript = '';

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  applySettingsToUI();
  updateProviderBadge();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;

  const isPRPage = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(tab.url || '');
  if (!isPRPage) { show('not-pr-page'); return; }

  const prMatch = tab.url.match(/github\.com\/([^/]+\/[^/]+\/pull\/\d+)/);
  sessionKey = `sess_${(prMatch?.[1] || 'unknown').replace(/\//g, '_')}`;

  show('main-panel');

  // Wire up listeners
  chrome.runtime.onMessage.addListener(handleContentMessage);

  $('btn-settings').addEventListener('click', toggleSettings);
  document.querySelectorAll('.provider-tab').forEach(btn =>
    btn.addEventListener('click', () => switchProviderTab(btn.dataset.provider))
  );
  $('btn-save-settings').addEventListener('click', saveSettings);
  document.querySelectorAll('.mode-btn').forEach(btn =>
    btn.addEventListener('click', () => switchMode(btn.dataset.mode))
  );
  $('btn-reload-context').addEventListener('click', () => loadPRContext(tab, true));
  $('btn-clear').addEventListener('click', clearSession);
  $('btn-ask').addEventListener('click', handleTextAsk);
  $('question-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextAsk(); }
  });
  document.querySelectorAll('.suggestion').forEach(btn =>
    btn.addEventListener('click', () => {
      $('question-input').value = btn.textContent;
      handleTextAsk();
    })
  );

  const ptt = $('btn-ptt');
  ptt.addEventListener('pointerdown', e => {
    e.preventDefault();
    ptt.setPointerCapture(e.pointerId);
    if (isSpeaking) stopSpeaking();
    if (!isListening) startListening();
  });
  ptt.addEventListener('pointerup', e => {
    e.preventDefault();
    if (isListening) stopListening();
  });
  ptt.addEventListener('pointercancel', () => {
    if (isListening) stopListening();
  });

  await restoreOrLoad(tab);
});

// ── Session — all storage goes through background worker ──────────────────────
function saveSession() {
  if (!prContext || !sessionKey) return;
  // Send to background worker — it stays alive even when popup closes
  chrome.runtime.sendMessage({
    type: 'SAVE_SESSION',
    key: sessionKey,
    payload: {
      prContext,
      conversationHistory: [...conversationHistory], // snapshot
      savedAt: Date.now()
    }
  }).catch(() => {}); // ignore if background not ready
}

async function restoreOrLoad(tab) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'LOAD_SESSION', key: sessionKey });
    const saved = res?.data;

    if (saved?.prContext && Array.isArray(saved.conversationHistory) && saved.conversationHistory.length > 0) {
      prContext = saved.prContext;
      conversationHistory = saved.conversationHistory;

      $('pr-label').textContent =
        `📋 ${prContext.repo} #${prContext.prNumber} · ${prContext.changedFiles.length} files · +${prContext.additions} -${prContext.deletions}`;
      $('context-preview').textContent = buildContextSummary(prContext);
      $('chat-log').innerHTML = '';

      for (const msg of conversationHistory) {
        if (msg.role === 'user') appendMessage('user', msg.content, false);
        else if (msg.role === 'assistant') appendMessage('ai', msg.content, false);
      }
      $('chat-log').scrollTop = $('chat-log').scrollHeight;
      setStatus('↩ Conversation restored');
      setTimeout(() => setStatus(''), 2500);
      return;
    }
  } catch (e) {
    console.warn('[Session] restore failed:', e);
  }

  await loadPRContext(tab, false);
}

async function clearSession() {
  conversationHistory = [];
  $('chat-log').innerHTML = '';
  if (sessionKey) {
    await chrome.runtime.sendMessage({ type: 'CLEAR_SESSION', key: sessionKey }).catch(() => {});
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await loadPRContext(tab, false);
}

// ── PR Context ────────────────────────────────────────────────────────────────
async function loadPRContext(tab, force = false) {
  $('pr-label').textContent = 'Fetching PR…';
  setStatus('');
  try {
    // Ensure content script is injected (safe to call multiple times)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content.js']
    }).catch(() => {});

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PR_CONTEXT' });
    if (!response?.success) throw new Error(response?.error || 'Could not fetch PR context');

    prContext = response.context;
    if (force) { conversationHistory = []; $('chat-log').innerHTML = ''; }

    $('pr-label').textContent =
      `📋 ${prContext.repo} #${prContext.prNumber} · ${prContext.changedFiles.length} files · +${prContext.additions} -${prContext.deletions}`;
    $('context-preview').textContent = buildContextSummary(prContext);

    if (!conversationHistory.length) {
      const intro = `I'm ${prContext.author}, and I wrote this PR — "${prContext.title}". Changed ${prContext.changedFiles.length} files on ${prContext.headBranch}. Ask me anything.`;
      appendMessage('ai', intro);
      conversationHistory.push({ role: 'assistant', content: intro });
      if (currentMode === 'voice') speak(intro);
    }

    saveSession();
  } catch (err) {
    $('pr-label').textContent = 'Failed to load PR';
    setStatus(`Error: ${err.message}`, 'error');
  }
}

function buildContextSummary(ctx) {
  return [
    `${ctx.repo} #${ctx.prNumber} by @${ctx.author}`,
    `Title: ${ctx.title}`,
    `Branch: ${ctx.headBranch} → ${ctx.baseBranch}`,
    `Changes: +${ctx.additions} -${ctx.deletions} across ${ctx.changedFiles.length} files`,
    '', 'Files:', ...ctx.changedFiles.map(f => `  • ${f}`)
  ].join('\n');
}

// ── Mode ──────────────────────────────────────────────────────────────────────
function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode)
  );
  $('voice-controls').classList.toggle('hidden', mode !== 'voice');
  $('text-controls').classList.toggle('hidden', mode !== 'text');
  if (mode !== 'voice') stopSpeaking();
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const stored = await chrome.storage.local.get('askpr_settings');
  if (stored.askpr_settings) settings = { ...settings, ...stored.askpr_settings };
}

function applySettingsToUI() {
  switchProviderTab(settings.provider, false);
  $('anthropic-key').value = settings.anthropic.key || '';
  $('anthropic-model').value = settings.anthropic.model || 'claude-sonnet-4-6';
  $('openai-key').value = settings.openai.key || '';
  $('openai-model').value = settings.openai.model || 'gpt-4o';
}

function updateProviderBadge() {
  const label = settings.provider === 'anthropic'
    ? `Anthropic · ${settings.anthropic.model?.split('-').slice(0, 2).join('-')}`
    : `OpenAI · ${settings.openai.model}`;
  $('provider-badge').textContent = label;
}

function switchProviderTab(provider, updateState = true) {
  if (updateState) settings.provider = provider;
  document.querySelectorAll('.provider-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.provider === provider)
  );
  document.querySelectorAll('.provider-settings').forEach(el => el.classList.add('hidden'));
  $(`settings-${provider}`)?.classList.remove('hidden');
}

function toggleSettings() { $('settings-panel').classList.toggle('hidden'); }

async function saveSettings() {
  settings.provider = document.querySelector('.provider-tab.active')?.dataset.provider || 'anthropic';
  settings.anthropic.key = $('anthropic-key').value.trim();
  settings.anthropic.model = $('anthropic-model').value;
  settings.openai.key = $('openai-key').value.trim();
  settings.openai.model = $('openai-model').value;
  await chrome.storage.local.set({ askpr_settings: settings });
  $('settings-panel').classList.add('hidden');
  updateProviderBadge();
  setStatus('Saved ✓');
}

function getActiveKey() {
  return settings.provider === 'anthropic' ? settings.anthropic.key : settings.openai.key;
}

// ── Voice ─────────────────────────────────────────────────────────────────────
function startListening() {
  liveTranscript = '';
  chrome.tabs.sendMessage(currentTabId, { type: 'START_RECOGNITION' }).catch(() => {
    setVoiceStatus('⚠ Refresh the GitHub tab and try again');
  });
}

function stopListening() {
  chrome.tabs.sendMessage(currentTabId, { type: 'STOP_RECOGNITION' }).catch(() => {});
}

function handleContentMessage(msg) {
  switch (msg.type) {
    case 'RECOGNITION_START':
      isListening = true;
      setVoiceStatus('🔴 Listening…', 'listening');
      $('btn-ptt').classList.add('active');
      $('btn-ptt').textContent = '🔴 Release to send';
      break;

    case 'RECOGNITION_RESULT':
      liveTranscript = msg.transcript;
      $('transcript-preview').textContent = msg.transcript;
      break;

    case 'RECOGNITION_END': {
      isListening = false;
      const transcript = liveTranscript.trim();
      liveTranscript = '';
      $('transcript-preview').textContent = '';
      resetPTTButton();
      if (transcript) handleVoiceQuestion(transcript);
      break;
    }

    case 'TTS_START':
      // UI already updated in speak() — nothing extra needed
      break;

    case 'TTS_END':
      isSpeaking = false;
      $('btn-ptt').onclick = null;
      $('btn-ptt').disabled = false;
      resetPTTButton();
      if (currentMode === 'voice') setVoiceStatus('Your turn — hold to respond');
      break;

    case 'TTS_ERROR':
      // 'interrupted' = speechSynthesis.cancel() was called (e.g. stop before next speak) — not a real error
      if (msg.error === 'interrupted') break;
      isSpeaking = false;
      $('btn-ptt').onclick = null;
      $('btn-ptt').disabled = false;
      resetPTTButton();
      console.warn('[TTS] error:', msg.error);
      break;

    case 'RECOGNITION_ERROR': {
      isListening = false;
      liveTranscript = '';
      $('transcript-preview').textContent = '';
      resetPTTButton();
      const errMap = {
        'not-allowed': '⚠ Mic denied — allow mic on github.com',
        'service-not-allowed': '⚠ Mic denied — allow mic on github.com',
        'no-speech': 'No speech — try again',
        'network': '⚠ Network error',
        'not-supported': '⚠ Voice not supported'
      };
      setVoiceStatus(errMap[msg.error] || `⚠ ${msg.error}`);
      break;
    }
  }
}

function resetPTTButton() {
  $('btn-ptt').classList.remove('active', 'speaking');
  if (!isSpeaking) {
    $('btn-ptt').textContent = 'Hold to Speak';
    setVoiceStatus('Ready');
  }
}

// Delegate TTS to content script — speechSynthesis is broken in extension popups
function speak(text) {
  isSpeaking = true;
  setVoiceStatus('💬 Author speaking…', 'speaking');
  $('btn-ptt').classList.add('speaking');
  $('btn-ptt').textContent = '⏹ Click to stop';
  $('btn-ptt').onclick = () => { if (isSpeaking) { stopSpeaking(); $('btn-ptt').onclick = null; } };

  chrome.tabs.sendMessage(currentTabId, { type: 'SPEAK', text }).catch(err => {
    console.warn('[TTS] failed to send to content script:', err);
    isSpeaking = false;
    resetPTTButton();
  });
}

function stopSpeaking() {
  chrome.tabs.sendMessage(currentTabId, { type: 'STOP_SPEAKING' }).catch(() => {});
  isSpeaking = false;
}

function setVoiceStatus(msg, cls = '') {
  const el = $('voice-status');
  el.textContent = msg;
  el.className = cls;
}

// ── Question handlers ─────────────────────────────────────────────────────────
async function handleVoiceQuestion(question) {
  if (!prContext) { setVoiceStatus('PR not loaded yet'); return; }
  if (!getActiveKey()) { setVoiceStatus('Add API key in ⚙ Settings'); toggleSettings(); return; }

  appendMessage('user', question);
  conversationHistory.push({ role: 'user', content: question });
  saveSession();

  setVoiceStatus('⏳ Thinking…', 'thinking');
  $('btn-ptt').disabled = true;
  $('btn-ptt').textContent = '⏳ Thinking…';

  let reply = null;
  try {
    reply = await callLLM(conversationHistory);
  } catch (err) {
    // Speak the error — even failures get a voiced response
    const friendlyError = friendlyErrorMessage(err.message);
    reply = friendlyError;
  }

  // Always push, save, show and speak — no silent failures
  conversationHistory.push({ role: 'assistant', content: reply });
  saveSession();
  appendMessage('ai', reply);
  speak(reply); // speak() re-enables PTT when done
}

async function handleTextAsk() {
  const question = $('question-input').value.trim();
  if (!question || !prContext) return;
  if (!getActiveKey()) { setStatus('Add API key in ⚙ Settings.', 'error'); toggleSettings(); return; }

  $('question-input').value = '';
  appendMessage('user', question);
  conversationHistory.push({ role: 'user', content: question });
  saveSession();

  $('btn-ask').disabled = true;
  setStatus('Thinking…');

  let reply = null;
  try {
    reply = await callLLM(conversationHistory);
  } catch (err) {
    reply = friendlyErrorMessage(err.message);
  }

  // Always push, save, show and speak — no silent failures
  conversationHistory.push({ role: 'assistant', content: reply });
  saveSession();
  appendMessage('ai', reply);
  speak(reply);
  setStatus('');
  $('btn-ask').disabled = false;
}

// ── Chat UI ───────────────────────────────────────────────────────────────────
function appendMessage(role, text, scroll = true) {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (role === 'ai') {
    const tag = document.createElement('span');
    tag.className = 'author-tag';
    tag.textContent = `✦ ${prContext?.author || 'AskPR'}`;
    div.appendChild(tag);
  }
  const content = document.createElement('span');
  content.textContent = text;
  div.appendChild(content);
  log.appendChild(div);
  if (scroll) log.scrollTop = log.scrollHeight;
}

// ── Error → friendly spoken message ──────────────────────────────────────────
function friendlyErrorMessage(errMsg) {
  if (errMsg.includes('api key') || errMsg.includes('API key') || errMsg.includes('x-api-key') || errMsg.includes('Incorrect API')) {
    return "Hey, it looks like the API key isn't set up correctly. Can you go into Settings and add a valid key? I can't respond without it.";
  }
  if (errMsg.includes('429') || errMsg.includes('rate limit') || errMsg.includes('Rate limit')) {
    return "Looks like we've hit a rate limit. Give it a moment and try again.";
  }
  if (errMsg.includes('network') || errMsg.includes('fetch') || errMsg.includes('Failed to fetch')) {
    return "I'm having trouble connecting right now. Check your internet connection and try again.";
  }
  if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503')) {
    return "The AI service seems to be having issues on their end. Try again in a moment.";
  }
  return "Something went wrong on my end. Try asking again.";
}

// ── LLM ───────────────────────────────────────────────────────────────────────
async function callLLM(messages) {
  return settings.provider === 'anthropic' ? callAnthropic(messages) : callOpenAI(messages);
}

async function callAnthropic(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': settings.anthropic.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: settings.anthropic.model,
      max_tokens: 1024,
      system: buildSystemPrompt(prContext),
      messages
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Anthropic ${res.status}`);
  }
  return (await res.json()).content?.[0]?.text || '(no response)';
}

async function callOpenAI(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.openai.key}`
    },
    body: JSON.stringify({
      model: settings.openai.model,
      max_tokens: 1024,
      messages: [{ role: 'system', content: buildSystemPrompt(prContext) }, ...messages]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `OpenAI ${res.status}`);
  }
  return (await res.json()).choices?.[0]?.message?.content || '(no response)';
}

function buildSystemPrompt(ctx) {
  const patches = ctx.patches?.length > 6000
    ? ctx.patches.slice(0, 6000) + '\n\n[… diff truncated …]'
    : ctx.patches;
  const commentsBlock = ctx.comments?.length
    ? `Review comments:\n${ctx.comments.join('\n\n')}`
    : 'Review comments: none';

  return `You are ${ctx.author}, the engineer who wrote this pull request. You and the reviewer are on a voice call doing a live PR review together.

Rules:
- Respond like a real person on a call — short, natural, conversational. 2-3 sentences max unless the question genuinely needs more.
- Never use bullet points, headers, or markdown. No lists. Just talk.
- Use ONLY the PR context below. Do not invent details not in the diff.
- If you don't know: "That's not clear from the diff, but my thinking was…"
- Use "I", "we", "yeah", "so", "honestly" — sound human, not like documentation.
- Reference specific file names or line changes when it helps, but keep it brief.

PR: ${ctx.repo} #${ctx.prNumber}
Title: ${ctx.title}
Description: ${ctx.description}
Branch: ${ctx.headBranch} → ${ctx.baseBranch}
Stats: +${ctx.additions} -${ctx.deletions} across ${ctx.changedFiles.length} files

Files:
${ctx.changedFiles.map(f => `  - ${f}`).join('\n')}

${commentsBlock}

Diff:
${patches}`;
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function show(id) {
  ['not-pr-page', 'main-panel'].forEach(s => $(s)?.classList.add('hidden'));
  $(id)?.classList.remove('hidden');
}

function setStatus(msg, type = '') {
  const el = $('status-msg');
  el.textContent = msg;
  el.style.color = type === 'error' ? 'var(--danger)' : 'var(--text-muted)';
}
