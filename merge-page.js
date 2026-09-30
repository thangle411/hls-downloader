import { mergeFiles } from "./merge.js";

const videoEl = document.getElementById("video");
const audioEl = document.getElementById("audio");
const offsetEl = document.getElementById("offset");
const preview = document.getElementById("preview");
const previewAudio = document.getElementById("previewAudio");
const mergeBtn = document.getElementById("merge");
const progressEl = document.getElementById("progress");
const statusEl = document.getElementById("status");
const setStatus = (t) => (statusEl.textContent = t);

const offsetSec = () => (parseFloat(offsetEl.value) || 0) / 1000;
const update = () => (mergeBtn.disabled = !(videoEl.files[0] && audioEl.files[0]));

videoEl.onchange = audioEl.onchange = () => {
  update();
  loadPreview();
  progressEl.style.width = "0%";
  setStatus(mergeBtn.disabled ? "Choose both files." : "Ready to merge. Play the preview to check sync.");
};

// Offset controls
const setOffset = (ms) => {
  offsetEl.value = Math.round(ms);
  syncPreview(true);
};
for (const b of document.querySelectorAll("[data-nudge]")) {
  b.onclick = () => setOffset((parseFloat(offsetEl.value) || 0) + Number(b.dataset.nudge));
}
document.getElementById("resetOffset").onclick = () => setOffset(0);
offsetEl.oninput = () => syncPreview(true);

// Preview: the video plays with the audio file alongside it, shifted by the
// offset, so the right value can be found by ear before merging.
let urls = [];
function loadPreview() {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  preview.pause();
  previewAudio.pause();
  const [video, audio] = [videoEl.files[0], audioEl.files[0]];
  preview.hidden = !video;
  if (video) urls.push((preview.src = URL.createObjectURL(video)));
  else preview.removeAttribute("src");
  if (audio) urls.push((previewAudio.src = URL.createObjectURL(audio)));
  else previewAudio.removeAttribute("src");
}
preview.onerror = () => {
  preview.hidden = true;
  setStatus("This video format can't be previewed here, but it can still be merged with the offset.");
};
previewAudio.onerror = () => {
  if (audioEl.files[0]) setStatus("This audio format can't be previewed here, but it can still be merged with the offset.");
};

// Keep the audio element at (video time - offset). Small drift is left alone
// because seeking audio causes an audible skip.
function syncPreview(force = false) {
  if (!previewAudio.src || !preview.src) return;
  const target = preview.currentTime - offsetSec();
  const outside = target < 0 || (previewAudio.duration && target > previewAudio.duration);
  if (preview.paused || outside) {
    previewAudio.pause();
    if (force || preview.paused) previewAudio.currentTime = Math.max(0, target);
    return;
  }
  previewAudio.playbackRate = preview.playbackRate;
  if (force || previewAudio.paused || Math.abs(previewAudio.currentTime - target) > 0.08) previewAudio.currentTime = target;
  if (previewAudio.paused) previewAudio.play().catch(() => {});
}
for (const ev of ["play", "pause", "seeked", "ratechange"]) preview.addEventListener(ev, () => syncPreview(ev === "seeked"));
preview.addEventListener("timeupdate", () => syncPreview());
// The video's volume controls drive the audio file.
preview.addEventListener("volumechange", () => {
  previewAudio.volume = preview.volume;
  previewAudio.muted = preview.muted;
});

mergeBtn.onclick = async () => {
  const video = videoEl.files[0];
  const audio = audioEl.files[0];
  const offset = offsetSec();
  // "Title (video).mp4" -> "Title.mp4"; anything else -> "Name merged.mp4".
  const stem = video.name.replace(/\.[^.]+$/, "");
  const base = stem.replace(/\s*\(video\)$/i, "");
  const filename = `${safeFilename(base)}${base === stem ? " merged" : ""}.mp4`;
  let writable = null;
  if (window.showSaveFilePicker) {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
      });
      writable = await handle.createWritable();
    } catch (e) {
      if (e.name !== "AbortError") setStatus(`Save dialog failed: ${e.message}`);
      return;
    }
  }

  preview.pause();
  mergeBtn.disabled = videoEl.disabled = audioEl.disabled = offsetEl.disabled = true;
  progressEl.style.width = "0%";
  setStatus(offset ? `Merging with audio ${offset > 0 ? "delayed" : "advanced"} by ${Math.round(Math.abs(offset * 1000))} ms…` : "Merging…");
  const started = Date.now();
  try {
    const blob = await mergeFiles({
      video,
      audio,
      writable,
      offset,
      onProgress: (p) => (progressEl.style.width = `${(p * 100).toFixed(1)}%`),
    });
    if (blob) {
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({ url, filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    }
    progressEl.style.width = "100%";
    setStatus(`Done in ${formatDuration((Date.now() - started) / 1000)}.`);
  } catch (e) {
    setStatus(`Merge failed: ${e.message}`);
    console.error(e);
  } finally {
    videoEl.disabled = audioEl.disabled = offsetEl.disabled = false;
    update();
  }
};
