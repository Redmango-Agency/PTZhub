# PTZ Hub — step-by-step guide

This guide is for first-time users, even without any experience with cameras or networks. If something doesn't work, look for your case below.

*Italiano: [guida.md](guida.md)*

## Contents

- [What you need before starting](#what-you-need-before-starting)
- [First start in 3 steps](#first-start-in-3-steps)
- [The camera asks for a password](#the-camera-asks-for-a-password)
- [The camera is not in the list](#the-camera-is-not-in-the-list)
- [Camera connected with the USB cable](#camera-connected-with-the-usb-cable)
- [I see the video but the camera doesn't move](#i-see-the-video-but-the-camera-doesnt-move)
- [I don't see the video](#i-dont-see-the-video)
- [Using the controls](#using-the-controls)
- [Presets](#presets)
- [New versions](#new-versions)
- [Still need help](#still-need-help)

## What you need before starting

1. **The camera switched on** and connected with a network cable to the same router or switch as the PC, or with the USB cable to the PC.
2. **The camera's user name and password**, if it has one: the ones of its web page or of the maker's app (not your Windows ones). Many VISCA cameras (Tenveo, PTZOptics and similar) don't ask for one; almost all Dahua, Hikvision, Axis and similar do.
3. On first start Windows may ask whether to **allow network access** for PTZ Hub: choose **Allow** (private networks). Without it the camera search finds nothing.

## First start in 3 steps

1. **Camera.** PTZ Hub searches the network and the USB cameras by itself. Click the right one: a check runs to see whether it can move, whether exact positions can be saved and whether there is video. When the check is green, press **Use this camera**.
2. **Video.** Choose where the preview comes from: the network (recommended) or the USB cable. You can skip it if you don't need a preview.
3. **Ready.** Save the first preset: move the camera with the arrows, then **+ New preset**.

Everything can be changed later in **Settings › Camera**.

## The camera asks for a password

The check shows **“The camera asks for a user name and password”** with two boxes.

1. Type the **user** (often `admin`) and the camera **password**. Use **Show** to check you typed it right: upper and lower case matter.
2. Press **Try**. If it works you see “Signed in” and **Use this camera** becomes active. The user name and password are saved with the camera, on your PC.

**If it is refused**, these are the most common cases:

- **ONVIF is switched off in the camera** (this often happens even with the right password). Press **Open the camera page**, sign in and enable ONVIF in the network settings. Names change a little between models:
  - **Dahua**: Settings › Network › Access Platform › ONVIF › Enable. If there is “ONVIF authentication”, leave it on and use the same user.
  - **Hikvision**: Configuration › Network › Advanced Settings › Integration Protocol › enable ONVIF, then **add an ONVIF user** (name and password) and use that one in PTZ Hub.
  - **Other makers**: look for “ONVIF” in the network or security settings.
- **New camera, never set up**: Dahua and Hikvision cameras must first be “activated” by choosing a password, from their web page or with the maker's app (Dahua ConfigTool, Hikvision SADP). Then come back to PTZ Hub and use that password.
- **Forgotten password**: it is reset on the camera (reset button or the maker's support). PTZ Hub cannot recover it.

You can also enter or change the user name and password later: **Settings › Camera › Access**, then **Detect again**.

## The camera is not in the list

- **Is it on and connected?** The lights on the camera's network socket should be on.
- **Same network as the PC?** PTZ Hub only searches the PC's network (shown at the top, for example `192.168.1.x`). If the camera has an address on another network (for example `192.168.0.100` while the PC is on `192.168.1.x`), change the camera address from its app or web page, or connect it to the same network.
- **Do you know the address?** Press **Enter the address by hand** and type it (for example `192.168.1.108`). You find it in the maker's app, in the router's device list or on the camera label.
- **Did Windows block PTZ Hub?** If you chose “Cancel” on the firewall prompt at first start, the search doesn't work: Windows Settings › Privacy & security › Windows Security › Firewall › Allow an app, and enable PTZ Hub for private networks.

## Camera connected with the USB cable

- Press **Camera connected over USB?** and choose the camera. “Virtual” cameras (OBS Virtual Camera, Snap Camera and similar) are not listed, because they have no head to move.
- **It only works if the camera accepts commands over USB.** Many PTZ cameras only send video over USB: the check tells you, and in that case connect it with the network cable.
- **Zoom, OBS and PTZ Hub together**: on Windows the controls work even while Zoom or OBS use the camera. The preview can be seen by one program at a time: PTZ Hub gives way to OBS and Zoom and shows the preview when the camera is free.
- **Jerky movement?** In Settings › Camera keep **Smooth movement over USB** on: if the camera supports it, movement is smooth and “Slow” moves just a little.

## I see the video but the camera doesn't move

- **The check says “video only” or “without movement”**: the camera answers but has no PTZ commands (it's a fixed camera, or the control is off). Check on its web page that ONVIF or VISCA are enabled.
- **VISCA off**: on some cameras (Tenveo, PTZOptics, Avonic…) VISCA over the network must be enabled in the camera web page (look for “VISCA over IP”).
- **Camera with a password**: see [The camera asks for a password](#the-camera-asks-for-a-password).

## I don't see the video

- **Over the network**: PTZ Hub tries the most common video addresses by itself. If it doesn't find one, in **Settings › Video preview** you can choose another address or type it (it's in the camera manual, it usually starts with `rtsp://`). Many cameras ask for the password for video too: PTZ Hub uses the camera one.
- **Over USB**: if Zoom or OBS are using the camera, the preview comes back by itself when they release it.
- The preview is optional: controls and presets work without it.

## Using the controls

- **Circle with 4 arrows**: press once to move a little (to centre), hold to move. **Home** in the middle takes the camera back to its start position.
- **Slow / Fast**: “Slow” for precise moves, “Fast” to travel far. Zoom has its own Slow / Fast.
- **STOP** (or the `Esc` and `Space` keys) stops everything, even a preset on its way.
- **Keyboard**: arrows to move (Shift = always slow), Page Up / Page Down to zoom, `1`–`9` and `0` for presets.

## Presets

- **Save**: frame the shot and press **+ New preset**. PTZ Hub saves the exact position (left/right, up/down, zoom and focus).
- **Recall**: click the thumbnail or press `1`–`9`, `0`. The camera always goes to that exact position, wherever it starts from.
- **Edit**: pencil on the thumbnail. Opening the editor does **not** move the camera: you can rename, reorder or delete without touching the live shot. To change the position: **Move the camera here**, adjust and **Save name and position**.
- **Reorder**: drag the thumbnails.
- Thumbnails update by themselves with the latest picture when you use them.

## New versions

PTZ Hub checks for a new version by itself (at start and every 6 hours) and shows **Download …** at the top: it opens the page with the installer. It never installs anything by itself.

## Still need help

Open an issue on GitHub with the camera model, how it is connected (network or USB) and a photo of the message: <https://github.com/Redmango-Agency/PTZhub/issues>
