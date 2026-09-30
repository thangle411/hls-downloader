// Watches network traffic for HLS playlists and video files, keyed by tab.

const HLS_RE = /\.m3u8(\?|#|$)/i;
const DASH_RE = /\.mpd(\?|#|$)/i;
const FILE_RE = /\.(mp4|webm|mov|m4v|mkv|flv|ogv)(\?|#|$)/i;
// Segments and fragments we never want to list.
const IGNORE_RE = /\.(ts|m4s|aac|vtt|key)(\?|#|$)/i;

const HLS_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"];

const key = (tabId) => `tab_${tabId}`;

async function getMedia(tabId) {
  const data = await chrome.storage.session.get(key(tabId));
  return data[key(tabId)] || [];
}

async function addMedia(tabId, item) {
  if (tabId < 0) return;
  const list = await getMedia(tabId);
  if (list.some((m) => m.url === item.url)) return;

  // Keep only master playlists when a variant of an already-seen master shows up
  // is hard to know here, so we keep everything and let the popup sort it out.
  list.push({ ...item, time: Date.now() });

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  for (const m of list) {
    m.pageTitle ||= tab.title;
    m.pageUrl ||= tab.url;
  }

  await chrome.storage.session.set({ [key(tabId)]: list });
  chrome.action.setBadgeBackgroundColor({ color: "#e5484d", tabId });
  chrome.action.setBadgeText({ text: String(list.length), tabId });
}

function headerValue(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId, responseHeaders, statusCode } = details;
    if (tabId < 0 || statusCode >= 400) return;
    if (url.startsWith("chrome-extension://")) return;

    const type = headerValue(responseHeaders, "content-type").toLowerCase().split(";")[0].trim();
    const size = parseInt(headerValue(responseHeaders, "content-length"), 10) || 0;
    const noQuery = url.split("?")[0];

    if (HLS_RE.test(noQuery) || HLS_TYPES.includes(type)) {
      addMedia(tabId, { url, kind: "hls" });
    } else if (DASH_RE.test(noQuery) || type === "application/dash+xml") {
      addMedia(tabId, { url, kind: "dash" });
    } else if (!IGNORE_RE.test(noQuery) && (FILE_RE.test(noQuery) || /^video\//.test(type))) {
      // Skip tiny responses (probing requests, byte-range slices of a larger file are fine).
      if (size && size < 100 * 1024 && !headerValue(responseHeaders, "content-range")) return;
      addMedia(tabId, { url, kind: "file", size, mime: type });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Reset the list when a tab navigates to a new page.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === "main_frame" && details.tabId >= 0) {
      chrome.storage.session.remove(key(details.tabId));
      chrome.action.setBadgeText({ text: "", tabId: details.tabId });
    }
  },
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(key(tabId)));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "getMedia") {
    getMedia(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === "clearMedia") {
    chrome.storage.session.remove(key(msg.tabId)).then(() => {
      chrome.action.setBadgeText({ text: "", tabId: msg.tabId });
      sendResponse(true);
    });
    return true;
  }
});
