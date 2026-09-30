// Many video CDNs reject requests without the original page's Referer.
// Requests made from extension pages don't carry one, so add it with a
// session DNR rule scoped to this extension and to one tab. Scoping per tab
// keeps a long download working if the popup is opened on another site.
// tabId -1 (chrome.tabs.TAB_ID_NONE) covers the popup.

const refererRuleId = (tabId) => (tabId < 0 ? 1 : tabId + 2);

async function setReferer(pageUrl, tabId = -1) {
  if (!pageUrl || !/^https?:/.test(pageUrl)) return;
  const id = refererRuleId(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "referer", operation: "set", value: pageUrl }],
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          tabIds: [tabId],
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },
    ],
  });
}

async function clearReferer(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [refererRuleId(tabId)] });
}

async function fetchWithRetry(url, { range, as = "arrayBuffer", retries = 6, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
      const res = await fetch(url, { headers, signal, credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res[as]();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      // Exponential backoff, capped: 1s, 2s, 4s, 8s, 15s, 15s.
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15000)));
    }
  }
  throw lastErr;
}
