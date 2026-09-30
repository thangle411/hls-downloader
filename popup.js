const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");

let tab;

init();

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  document.getElementById("merge").onclick = () => chrome.tabs.create({ url: "merge.html" });
  document.getElementById("clear").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "clearMedia", tabId: tab.id });
    render([]);
  };
  await setReferer(tab.url);
  const media = await chrome.runtime.sendMessage({ type: "getMedia", tabId: tab.id });
  render(await collapseVariants(media || []));
}

// Fetch each HLS playlist; drop media playlists that are variants of a master we also saw.
async function collapseVariants(media) {
  const hls = media.filter((m) => m.kind === "hls");
  await Promise.all(
    hls.map(async (m) => {
      try {
        m.playlist = parsePlaylist(await fetchWithRetry(m.url, { as: "text", retries: 1 }), m.url);
      } catch (e) {
        m.error = e.message;
      }
    })
  );
  const variantUrls = new Set();
  for (const m of hls) {
    if (m.playlist?.type === "master") {
      m.playlist.variants.forEach((v) => variantUrls.add(v.url));
      m.playlist.audio.forEach((a) => variantUrls.add(a.url));
    }
  }
  return media.filter((m) => !variantUrls.has(m.url));
}

function render(media) {
  listEl.innerHTML = "";
  emptyEl.hidden = media.length > 0;
  for (const m of media) listEl.appendChild(m.kind === "hls" ? hlsCard(m) : fileCard(m));
}

function card(m, tagText, metaText) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `
    <div class="title"><span class="tag"></span><span class="name"></span></div>
    <div class="meta"></div>
    <div class="url"></div>
    <div class="row"></div>`;
  el.querySelector(".tag").textContent = tagText;
  el.querySelector(".name").textContent = m.pageTitle || tab.title;
  el.querySelector(".meta").textContent = metaText;
  el.querySelector(".url").textContent = m.url;
  el.querySelector(".url").title = m.url;
  return el;
}

function copyButton(url) {
  const b = document.createElement("button");
  b.className = "ghost";
  b.textContent = "Copy URL";
  b.onclick = async () => {
    await navigator.clipboard.writeText(url);
    b.textContent = "Copied";
    setTimeout(() => (b.textContent = "Copy URL"), 1200);
  };
  return b;
}

function hlsCard(m) {
  const p = m.playlist;
  let meta = m.error ? `Could not read playlist: ${m.error}` : "";
  if (p?.type === "media") {
    meta = p.isLive ? "Live stream" : `${formatDuration(p.duration)} · ${p.segments.length} segments`;
    if (p.segments[0]?.key?.method === "SAMPLE-AES") meta += " · DRM (not supported)";
  } else if (p?.type === "master") {
    meta = `${p.variants.length} qualities`;
  }

  const el = card(m, "HLS", meta);
  const row = el.querySelector(".row");

  let select;
  if (p?.type === "master" && p.variants.length) {
    select = document.createElement("select");
    for (const v of p.variants) {
      const opt = document.createElement("option");
      opt.value = v.url;
      opt.textContent = [v.resolution || "audio/unknown", v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(2)} Mbps` : ""]
        .filter(Boolean)
        .join(" · ");
      select.appendChild(opt);
    }
    row.appendChild(select);
  }

  const btn = document.createElement("button");
  btn.textContent = "Download";
  btn.disabled = !p;
  btn.onclick = () => {
    const mediaUrl = select ? select.value : m.url;
    let audioUrl = "";
    if (p?.type === "master") {
      const variant = p.variants.find((v) => v.url === mediaUrl);
      const group = p.audio.filter((a) => a.group === variant?.audioGroup);
      audioUrl = (group.find((a) => a.isDefault) || group[0])?.url || "";
    }
    const params = new URLSearchParams({
      url: mediaUrl,
      audio: audioUrl,
      title: m.pageTitle || tab.title || "video",
      referer: m.pageUrl || tab.url,
    });
    chrome.tabs.create({ url: `downloader.html?${params}` });
  };
  row.appendChild(btn);
  row.appendChild(copyButton(m.url));
  return el;
}

function fileCard(m) {
  const ext = (m.url.split("?")[0].match(/\.(\w{2,4})$/) || [, "mp4"])[1].toLowerCase();
  const el = card(m, ext.toUpperCase(), [m.mime, formatBytes(m.size)].filter(Boolean).join(" · "));
  const row = el.querySelector(".row");
  const btn = document.createElement("button");
  btn.textContent = "Download";
  btn.onclick = () => {
    chrome.downloads.download({ url: m.url, filename: `${safeFilename(m.pageTitle || tab.title)}.${ext}`, saveAs: true });
  };
  row.appendChild(btn);
  row.appendChild(copyButton(m.url));
  return el;
}
