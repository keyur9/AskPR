# AskPR

> Talk to a GitHub PR as if you're talking to the engineer who wrote it.

Instead of Slacking the author "why did you do X?", open this Chrome extension on any GitHub PR and ask — by voice or text. The AI responds **as the author**, grounded only in what's in the PR diff, description, and comments.

---

## How it works

1. Open any GitHub PR
2. Click the AskPR extension icon
3. Hold the mic button and ask your question out loud
4. Release — the AI thinks, then responds in the author's voice
5. Keep going — it's a real back-and-forth conversation

The hypothesis: an LLM can answer reviewer questions well enough — using only PR context — that you'd reach for this before pinging the author on Slack.

---

## Install (Developer Mode)

```bash
git clone https://github.com/kempjohn9/askpr.git
cd askpr
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked** → select the `askpr` folder
4. AskPR icon appears in your toolbar

---

## Setup

**Get an API key** from one of:
- [console.anthropic.com](https://console.anthropic.com) → API Keys (`sk-ant-...`)
- [platform.openai.com/api-keys](https://platform.openai.com/api-keys) (`sk-...`)

**Add it to AskPR:**
1. Open any GitHub PR
2. Click the extension icon → ⚙ Settings
3. Choose provider, paste your key, click **Save Settings**

Keys are stored locally in `chrome.storage.local` — never leave your device except to go directly to the LLM provider.

---

## Usage

### Voice (default)

- **Hold** the button → speak your question → **release**
- AI responds in the author's voice, both as text and spoken aloud
- When it finishes, status shows "Your turn" — hold and go again
- **Click** while AI is speaking to interrupt

**First use:** Chrome asks for mic permission on github.com — click Allow.

### Text

Click **💬 Text** tab for typed chat with suggested starter questions.

### Controls

| Button | Action |
|--------|--------|
| ↺ | Re-fetch PR from GitHub |
| 🗑 | Clear conversation |
| ⚙ | Settings (API key, model, provider) |

Conversations persist per PR URL — close and reopen the popup freely.

---

## Security

- API keys stored only on your device, sent directly to the LLM provider — no proxy, no server
- GitHub API calls are unauthenticated (public repos only in this version)
- Extension only activates on `github.com/*/pull/*` URLs
- Background worker validates all message types and URL parameters

---

## File structure

```
askpr/
├── manifest.json       # Chrome Manifest V3
├── popup.html          # Extension UI
├── popup.css           # Dark theme styling
├── icons/
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── background.js   # Service worker: GitHub API + session storage
    ├── content.js      # Injected into GitHub: speech recognition + TTS
    └── popup.js        # UI logic: chat, voice, settings, LLM calls
```

---

## Validating the MVP

Test against real PRs. Score each answer:

| Score | Meaning |
|-------|---------|
| 0 | Useless / hallucinated |
| 1 | Generic — applies to any PR |
| 2 | Useful — grounded in the actual diff |
| 3 | Very useful — I'd use this instead of Slacking the author |

Good starter questions:
- *"Walk me through what changed here"*
- *"Why was this approach chosen?"*
- *"What could break?"*
- *"What tests are missing?"*
- *"Summarize this PR in 60 seconds"*

---

## Known limitations

- **Public repos only** — private repos need a GitHub token (not yet implemented)
- **Chrome only** — Web Speech API not supported in Firefox or Safari
- **Large diffs truncated** — patches capped at ~6000 chars; very large PRs lose tail context
- **No conversation export** — history lives in browser storage only

---

## Roadmap

**Near-term**
- [ ] Private repo support via GitHub personal access token
- [ ] Natural voice via ElevenLabs TTS
- [ ] Inject "Ask PR" button directly into the GitHub PR page
- [ ] Export conversation as Markdown

**Medium-term**
- [ ] GitHub OAuth — no BYOK needed
- [ ] Commit-level context — ask about individual commits
- [ ] Auto-suggest questions based on the diff

**Longer-term**
- [ ] Team mode — share a PR conversation with other reviewers
- [ ] Review draft generation from the conversation
- [ ] Slack integration — post Q&A back to the PR thread
