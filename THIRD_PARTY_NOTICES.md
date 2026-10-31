# Third-party software / Software di terze parti

PTZ Hub is released under the MIT License (see `LICENSE`). The distributed
installer also contains the following components, each under its own license.

## FFmpeg

The Windows package bundles a static build of **FFmpeg** (`resources/ffmpeg/ffmpeg.exe`),
used as a separate program to decode the camera's video stream for the preview.
It is licensed under the **GNU General Public License v3** (full text in
`resources/ffmpeg/LICENSE.txt` inside the installed app).

- FFmpeg source code: https://ffmpeg.org/download.html
- Windows build used: https://www.gyan.dev/ffmpeg/builds/ (distributed via
  https://github.com/eugeneware/ffmpeg-static, release `b6.1.1`)

## Electron and Chromium

The application runs on **Electron** (MIT License) which includes **Chromium**
and other components. Their licenses are included in the installed app as
`LICENSE.electron.txt` and `LICENSES.chromium.html`.
