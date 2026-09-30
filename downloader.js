const params = new URLSearchParams(location.search);
const title = safeFilename(params.get("title"));

const progressEl = document.getElementById("progress");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const cancelBtn = document.getElementById("cancel");
const saveBtn = document.getElementById("save");
const altBtn = document.getElementById("alt");
const controller = new AbortController();
let outputs = [];
let finished = false;
let tabId;

const setStatus = (t) => (statusEl.textContent = t);
const log = (t) => (logEl.textContent += t + "\n");
const abortOutputs = () => Promise.all(outputs.map((o) => o.abort()));

document.getElementById("name").textContent = title;
document.title = `Downloading ${title}`;

cancelBtn.onclick = async () => {
  if (finished) return window.close();
  finished = true;
  controller.abort();
  await abortOutputs();
  setStatus("Cancelled. Partial files were discarded.");
  cancelBtn.textContent = "Close";
  saveBtn.hidden = altBtn.hidden = true;
};
window.addEventListener("beforeunload", (e) => {
  if (!finished) e.preventDefault();
});

main().catch(async (e) => {
  if (controller.signal.aborted && finished) return;
  finished = true;
  controller.abort();
  await abortOutputs();
  setStatus(`Failed: ${e.message}`);
  log(e.stack || String(e));
  cancelBtn.textContent = "Close";
  saveBtn.hidden = altBtn.hidden = true;
});

async function main() {
  tabId = (await chrome.tabs.getCurrent()).id;
  await setReferer(params.get("referer"), tabId);

  const signal = controller.signal;
  const video = new HlsDownload({ url: params.get("url"), label: "video", signal, log });
  const audioUrl = params.get("audio");
  const audio = audioUrl && new HlsDownload({ url: audioUrl, label: "audio", signal, log, concurrency: 3 });

  setStatus("Checking stream…");
  await Promise.all([video.prepare(), audio?.prepare()]);

  // Video and audio are saved as separate files rather than muxed together.
  const jobs = [{ dl: video, suffix: "" }];
  if (audio && video.hasAudio()) {
    log("Video already contains audio; skipping the separate audio track.");
  } else if (audio) {
    jobs[0].suffix = " (video)";
    jobs.push({ dl: audio, suffix: " (audio)" });
    // Shift both files by the same amount so they stay in sync with each other.
    if (!video.raw && !audio.raw) {
      const start = Math.min(video.startTime(), audio.startTime());
      video.setStart(start);
      audio.setStart(start);
    }
  }

  const duration = Math.max(...jobs.map((j) => j.dl.duration));
  const estimatedBytes = jobs.reduce((n, j) => n + j.dl.estimatedBytes, 0);
  const summary = `${formatDuration(duration)} · about ${formatBytes(estimatedBytes)}.`;

  // With separate audio, either save one merged MP4 (tracks go to temporary
  // storage first) or save both tracks as files to merge later.
  let merged = null;
  if (jobs.length > 1) {
    if (await hasTempSpace(estimatedBytes)) {
      setStatus(`${summary} Save one merged MP4, or the video and audio as separate files to merge yourself later.`);
      merged = await chooseOutput(`${title}.mp4`, "mp4", "merged MP4", { alt: "Save as separate files" });
      if (merged === ALT) merged = null;
    } else {
      log("Not enough temporary storage to merge while downloading; saving as separate files.");
    }
  }

  if (merged) {
    outputs.push(merged);
    for (const j of jobs) {
      j.output = await tempOutput(`${j.dl.label}.${j.dl.ext()}`);
      outputs.push(j.output);
    }
  } else {
    setStatus(`${summary} ${jobs.length > 1 ? "Choose where to save the video and audio files." : "Choose where to save it."}`);
    // Each save picker needs its own click, so ask for them one at a time.
    for (const j of jobs) {
      const ext = j.dl.ext();
      j.output = await chooseOutput(`${title}${j.suffix}.${ext}`, ext, jobs.length > 1 ? j.dl.label : "");
      outputs.push(j.output);
    }
  }

  const started = Date.now();
  const report = () => {
    const done = jobs.reduce((n, j) => n + (j.done || 0), 0);
    const total = jobs.reduce((n, j) => n + j.dl.total, 0);
    const bytesWritten = jobs.reduce((n, j) => n + j.dl.bytesWritten, 0);
    const speed = jobs.reduce((n, j) => n + j.dl.bytesDownloaded, 0) / ((Date.now() - started) / 1000);
    progressEl.style.width = `${((done / total) * 100).toFixed(1)}%`;
    const eta = speed > 0 ? (estimatedBytes - bytesWritten) / speed : 0;
    setStatus(
      `${done}/${total} segments · ${formatBytes(bytesWritten)} of ~${formatBytes(estimatedBytes)} · ${formatBytes(speed)}/s` +
        (eta > 0 ? ` · ${formatDuration(eta)} left` : "")
    );
  };

  await Promise.all(
    jobs.map(async (j) => {
      await j.dl.run(j.output, ({ done }) => {
        j.done = done;
        report();
      });
      await j.output.close();
      log(`${j.dl.label}: finished.`);
    })
  );
  await clearReferer(tabId);

  const written = jobs.reduce((n, j) => n + j.dl.bytesWritten, 0);
  let result = `Saved ${formatBytes(written)}${jobs.length > 1 ? " in 2 files" : ""}.`;
  if (merged) {
    if (await mergeDownloads(jobs, merged)) result = "Saved the merged MP4.";
    else result = await saveSeparately(jobs);
    await Promise.all(jobs.map((j) => j.output.remove()));
  }

  progressEl.style.width = "100%";
  setStatus(`Done in ${formatDuration((Date.now() - started) / 1000)}. ${result}`);
  finished = true;
  cancelBtn.textContent = "Close";
  document.title = `✓ ${title}`;
}

// Merge the downloaded video and audio into `merged`. Returns false on failure.
async function mergeDownloads(jobs, merged) {
  setStatus("Merging video and audio into one MP4…");
  progressEl.style.width = "0%";
  const started = Date.now();
  try {
    const { mergeFiles } = await import("./merge.js");
    const [video, audio] = await Promise.all(jobs.map((j) => j.output.getFile()));
    const blob = await mergeFiles({
      video,
      audio,
      writable: merged.writable || null,
      onProgress: (p) => (progressEl.style.width = `${(p * 100).toFixed(1)}%`),
    });
    if (blob) {
      await merged.write(blob);
      await merged.close();
    }
    log(`Merged into one MP4 in ${formatDuration((Date.now() - started) / 1000)}.`);
    return true;
  } catch (e) {
    if (controller.signal.aborted) throw e;
    await merged.abort();
    log(`Merge failed: ${e.message}`);
    return false;
  }
}

// After a failed merge, let the user keep the downloaded tracks as separate files.
async function saveSeparately(jobs) {
  setStatus("Merging failed (see log). You can still save the video and audio as separate files.");
  let saved = 0;
  for (const j of jobs) {
    const ext = j.dl.ext();
    const out = await chooseOutput(`${title}${j.suffix}.${ext}`, ext, j.dl.label, { alt: `Skip ${j.dl.label}` });
    if (out === ALT) continue;
    outputs.push(out);
    await out.write(await j.output.getFile());
    await out.close();
    saved++;
  }
  return saved ? `Merging failed; saved ${saved} separate file${saved > 1 ? "s" : ""}.` : "Merging failed; nothing was saved.";
}

// Tracks for a merged download are staged in the extension's private storage
// (OPFS), which needs no save dialog. Files are prefixed with a timestamp so
// leftovers from crashed or closed tabs can be cleaned up later.
const TEMP_MAX_AGE = 24 * 60 * 60 * 1000;

async function hasTempSpace(bytes) {
  if (!navigator.storage?.getDirectory) return false;
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  return quota - usage > bytes * 1.2;
}

async function tempOutput(name) {
  const dir = await navigator.storage.getDirectory();
  for await (const [entry] of dir.entries()) {
    if (Date.now() - parseInt(entry, 10) > TEMP_MAX_AGE) await dir.removeEntry(entry).catch(() => {});
  }
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  const remove = () => dir.removeEntry(filename).catch(() => {});
  return {
    write: (bytes) => writable.write(bytes),
    close: () => writable.close(),
    abort: async () => {
      await writable.abort().catch(() => {});
      await remove();
    },
    getFile: () => handle.getFile(),
    remove,
  };
}

const TYPES = {
  mp4: ["video/mp4", "MP4 video"],
  m4a: ["audio/mp4", "M4A audio"],
  ts: ["video/mp2t", "MPEG-TS"],
  aac: ["audio/aac", "AAC audio"],
  mp3: ["audio/mpeg", "MP3 audio"],
  ac3: ["audio/ac3", "AC-3 audio"],
  ec3: ["audio/eac3", "E-AC-3 audio"],
};

// Resolves to an output, or ALT if an `alt` button label is given and clicked.
const ALT = Symbol("alt");
function chooseOutput(filename, ext, label, { alt = "" } = {}) {
  const [mime, description] = TYPES[ext] || ["application/octet-stream", ext.toUpperCase()];
  saveBtn.hidden = false;
  const noun = label ? ` ${label}` : "";
  saveBtn.textContent = window.showSaveFilePicker ? `Save${noun} as…` : `Start${noun} download`;
  altBtn.hidden = !alt;
  altBtn.textContent = alt;
  return new Promise((resolve) => {
    altBtn.onclick = () => {
      saveBtn.hidden = altBtn.hidden = true;
      resolve(ALT);
    };
    saveBtn.onclick = async () => {
      if (!window.showSaveFilePicker) {
        saveBtn.hidden = altBtn.hidden = true;
        return resolve(blobOutput(filename, mime));
      }
      try {
        const handle = await showSaveFilePicker({
          suggestedName: filename,
          types: [{ description, accept: { [mime]: [`.${ext}`] } }],
        });
        const writable = await handle.createWritable();
        saveBtn.hidden = altBtn.hidden = true;
        log(`Writing${noun} to ${handle.name}`);
        resolve({
          writable,
          write: (bytes) => writable.write(bytes),
          close: () => writable.close(),
          abort: () => writable.abort().catch(() => {}),
          getFile: () => handle.getFile(),
        });
      } catch (e) {
        if (e.name !== "AbortError") log(`Save dialog failed: ${e.message}`);
        // Picker dismissed: leave the button up so they can try again.
      }
    };
  });
}

// Fallback when the File System Access API isn't available: build a Blob
// (Chrome spills large Blobs to disk) and hand it to the downloads API.
function blobOutput(filename, mime) {
  let parts = [];
  let blob = null;
  return {
    write: async (bytes) => void parts.push(bytes),
    close: async () => {
      blob = new Blob(parts, { type: mime });
      const url = URL.createObjectURL(blob);
      parts = null;
      await chrome.downloads.download({ url, filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    },
    abort: async () => void (parts = blob = null),
    getFile: async () => blob,
  };
}
