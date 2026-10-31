PTZ PANEL — control panel for network PTZ cameras
==================================================

INSTALLATION
1. Run "PTZ-Panel-Setup-<version>.exe": the app is installed for all
   accounts on this PC, with Start menu and desktop shortcuts. The installer
   also opens the Windows firewall for the camera.
2. Windows may show "Windows protected your PC" (the app is not signed):
   click "More info" > "Run anyway".
   Portable version (zip): extract it and run "PTZ Panel.exe"; if the
   firewall asks, allow both private and public networks.

FIRST SETUP (once per account)
1. Settings > "Search network" and click the camera address
   (or type the IP and press "Detect protocol").
2. Video preview: "Find" looks for the RTSP stream automatically.
   If the camera is connected by USB to this PC, choose "USB".
3. Save.

USE
- "+ New preset": opens the editor with preview and controls. Frame the
  shot with joystick, arrow keys and zoom, give it a name and press Save:
  the camera's position, zoom and focus are stored, plus a thumbnail.
- Click a preset or press keys 1…9, 0: the camera goes back exactly there.
- Pencil (or right-click) on a preset: the camera moves there and you can
  adjust, rename, reorder or delete it.
- Joystick or arrow keys: move (Shift = slow). PgUp/PgDn or +/-: zoom.
- Esc or Space: immediate STOP.
- "Always on top": keeps the window above OBS/vMix/PowerPoint.
- "Compact": small preview, presets and STOP only.
- Settings > "Shortcuts work even when other programs are in front":
  Ctrl+Alt+1…0 recall, Ctrl+Alt+S stop.
- Settings > Language: Italian or English (automatic by default).

WHERE DATA IS STORED
%APPDATA%\PTZ Panel (impostazioni.json and preset.json), one per account.
Presets can be exported and imported from Settings.

License: MIT. Source code and updates: see the project page on GitHub.
