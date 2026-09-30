// Merges a video file and an audio file into one regular (non-fragmented) MP4
// with Mediabunny. Streams are copied, not re-encoded, so it takes seconds.
// Loaded as an ES module: statically from merge.html, dynamically from downloader.js.

import {
  Input,
  Output,
  Conversion,
  ALL_FORMATS,
  BlobSource,
  Mp4OutputFormat,
  StreamTarget,
  BufferTarget,
  EncodedPacketSink,
  EncodedAudioPacketSource,
} from "./vendor/mediabunny.min.mjs";

// video, audio: File/Blob. writable: a FileSystemWritableFileStream to write to,
// or null to get the result back as a Blob. offset: seconds to shift the audio
// by; positive delays it, negative makes it play earlier. onProgress(0..1).
export async function mergeFiles({ video, audio, writable, offset = 0, onProgress = () => {} }) {
  let failed = false;
  // Mediabunny closes the stream when it's done or cancelled; route that through
  // us so a failed merge discards the partial file instead of saving it.
  const target = writable
    ? new StreamTarget(
        new WritableStream({
          write: (chunk) => writable.write(chunk),
          close: () => (failed ? writable.abort() : writable.close()),
          abort: () => writable.abort(),
        }),
        { chunked: true }
      )
    : new BufferTarget();
  // fastStart: false writes the index (moov) after the media, so nothing has to be held in memory.
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });

  const videoInput = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
  const audioInput = new Input({ source: new BlobSource(audio), formats: ALL_FORMATS });
  try {
    if (!(await videoInput.getPrimaryVideoTrack())) throw new Error(`${video.name || "Video file"} has no video track`);
    const audioTrack = await audioInput.getPrimaryAudioTrack();
    if (!audioTrack) throw new Error(`${audio.name || "Audio file"} has no audio track`);
    if (!audioTrack.codec) throw new Error("Unknown audio codec");

    // trim.start 0 keeps the video's own timestamps; by default it would be
    // shifted to start at 0, losing any offset between the two files.
    const conversion = await Conversion.init({ input: videoInput, output, composable: true, audio: { discard: true }, trim: { start: 0 } });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.filter((d) => d.reason !== "discarded_by_user").map((d) => `${d.track.type}: ${d.reason}`);
      throw new Error(`Can't merge these files (${reasons.join(", ") || "unsupported"})`);
    }

    // Audio is copied packet by packet so its timestamps can be shifted.
    const audioSource = new EncodedAudioPacketSource(audioTrack.codec);
    output.addAudioTrack(audioSource, { languageCode: audioTrack.languageCode });
    const decoderConfig = await audioTrack.getDecoderConfig();
    const audioDuration = (await audioTrack.computeDuration()) || 1;

    const progress = [0, 0];
    const report = (i, p) => {
      progress[i] = p;
      onProgress((progress[0] + progress[1]) / 2);
    };
    conversion.onProgress = (p) => report(0, p);

    const copyAudio = async () => {
      let first = true;
      for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
        const timestamp = packet.timestamp + offset;
        if (timestamp < 0) continue; // shifted before the start of the video
        await audioSource.add(packet.clone({ timestamp }), first ? { decoderConfig } : undefined);
        first = false;
        report(1, Math.min(1, packet.timestamp / audioDuration));
      }
      if (first) throw new Error("The offset moves all of the audio before the start of the video");
      audioSource.close();
      report(1, 1);
    };

    await output.start();
    await Promise.all([conversion.execute(), copyAudio()]);
    await output.finalize();
  } catch (e) {
    failed = true;
    await output.cancel().catch(() => {});
    await writable?.abort().catch(() => {});
    throw e;
  } finally {
    videoInput.dispose();
    audioInput.dispose();
  }
  if (!writable) return new Blob([target.buffer], { type: "video/mp4" });
}
