# hls-downloader

A Chrome extension that detects HLS (m3u8) streams and video files on a page and saves them as MP4. Streams with separate audio can be saved as one merged MP4, or as separate video and audio files that you merge later (with an adjustable audio offset) from **Merge files** in the popup.

## Install

1. Download `hls-downloader.zip` and unzip it. You'll get a `hls-downloader` folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `hls-downloader` folder.
5. Pin the extension from the puzzle-piece menu so its icon is easy to reach.

Keep the folder somewhere permanent: Chrome loads the extension from it, so deleting or moving the folder removes the extension.

## Use

Play the video on the page, then click the extension icon. Detected streams are listed with a **Download** button. DRM-protected streams can't be downloaded.
