// background.js — service worker
// Handles: GitHub API fetching, session persistence (outlives popup)
// SECURITY: No API keys ever pass through here. Keys live only in popup memory
//           and are sent directly from popup to LLM providers. Only GitHub
//           public API calls (no auth) and chrome.storage reads/writes happen here.

// ── GitHub API ────────────────────────────────────────────────────────────────
async function ghFetch(url, accept = 'application/vnd.github+json') {
  // Validate URL is GitHub API only — prevents SSRF if message is somehow spoofed
  if (!url.startsWith('https://api.github.com/')) {
    throw new Error('Invalid URL: only api.github.com is allowed');
  }

  const res = await fetch(url, {
    headers: {
      'Accept': accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PR-Author-AI-Extension'
    }
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return accept.includes('diff') ? res.text() : res.json();
}

async function ghFetchSafe(url, fallback = [], accept = 'application/vnd.github+json') {
  try { return await ghFetch(url, accept); }
  catch (e) { console.warn('[AskPR]', e.message); return fallback; }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // Only accept messages from our own extension pages
  if (sender.id !== chrome.runtime.id) return;

  // ── GitHub PR fetch ───────────────────────────────────────────────────────
  if (request.type === 'FETCH_PR_CONTEXT') {
    const { owner, repo, prNumber } = request;

    // Validate inputs — prevent path traversal or injection in URL
    if (!/^[a-zA-Z0-9._-]+$/.test(owner) ||
        !/^[a-zA-Z0-9._-]+$/.test(repo) ||
        !/^\d+$/.test(String(prNumber))) {
      sendResponse({ success: false, error: 'Invalid PR parameters' });
      return;
    }

    const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

    ghFetch(base)
      .then(pr => Promise.all([
        Promise.resolve(pr),
        ghFetchSafe(`${base}/files?per_page=100`, []),
        ghFetchSafe(`${base}/comments?per_page=50`, []),
        ghFetchSafe(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=50`, []),
        ghFetchSafe(base, '', 'application/vnd.github.diff')
      ]))
      .then(([pr, files, reviewComments, issueComments, diff]) => {
        const changedFiles = files.map(f => f.filename);
        const patches = files
          .filter(f => f.patch)
          .map(f => `--- ${f.filename} (+${f.additions} -${f.deletions})\n${f.patch}`)
          .join('\n\n');
        const comments = [
          ...reviewComments.map(c => `[Review on ${c.path || '?'}] ${c.user?.login}: ${c.body}`),
          ...issueComments.map(c => `[Comment] ${c.user?.login}: ${c.body}`)
        ].slice(0, 30);

        sendResponse({
          success: true,
          context: {
            owner,
            repo: `${owner}/${repo}`,
            prNumber,
            title: pr.title,
            description: pr.body || '(No description provided)',
            author: pr.user?.login || 'unknown',
            state: pr.state,
            baseBranch: pr.base?.ref,
            headBranch: pr.head?.ref,
            changedFiles,
            additions: pr.additions,
            deletions: pr.deletions,
            patches,
            diff: typeof diff === 'string' ? diff.slice(0, 8000) : '',
            comments
          }
        });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // ── Session save ──────────────────────────────────────────────────────────
  if (request.type === 'SAVE_SESSION') {
    const { key, payload } = request;

    // Validate key format — must match our session key pattern
    if (typeof key !== 'string' || !key.startsWith('sess_')) {
      sendResponse({ ok: false, error: 'Invalid session key' });
      return;
    }

    // Strip API keys from payload before storing — they must never be persisted
    const safePayload = {
      prContext: payload.prContext,
      conversationHistory: payload.conversationHistory,
      savedAt: payload.savedAt
    };

    chrome.storage.local.set({ [key]: safePayload })
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Session load ──────────────────────────────────────────────────────────
  if (request.type === 'LOAD_SESSION') {
    if (typeof request.key !== 'string' || !request.key.startsWith('sess_')) {
      sendResponse({ ok: false, error: 'Invalid session key' });
      return;
    }
    chrome.storage.local.get(request.key)
      .then(result => sendResponse({ ok: true, data: result[request.key] || null }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Session clear ─────────────────────────────────────────────────────────
  if (request.type === 'CLEAR_SESSION') {
    if (typeof request.key !== 'string' || !request.key.startsWith('sess_')) {
      sendResponse({ ok: false });
      return;
    }
    chrome.storage.local.remove(request.key)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
