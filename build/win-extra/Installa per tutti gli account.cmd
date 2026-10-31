@echo off
setlocal
title Installazione PTZ Panel

rem Serve l'amministratore per scrivere in Programmi: se manca, si rilancia chiedendolo
fltmc >nul 2>&1
if errorlevel 1 (
  set "SELF=%~f0"
  powershell -NoProfile -Command "Start-Process -FilePath $env:SELF -Verb RunAs"
  exit /b
)

set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
set "DEST=%ProgramFiles%\PTZ Panel"

if not exist "%SRC%\PTZ Panel.exe" (
  echo Non trovo "PTZ Panel.exe". Estrai prima tutto lo zip in una cartella, poi rilancia questo file.
  pause
  exit /b 1
)

taskkill /im "PTZ Panel.exe" /t /f >nul 2>&1

echo Copio i file in "%DEST%"...
robocopy "%SRC%" "%DEST%" /E /R:3 /W:2 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo Copia non riuscita: chiudi PTZ Panel su tutti gli account e riprova.
  pause
  exit /b 1
)

echo Creo i collegamenti nel menu Start e sul desktop di tutti gli account...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $t=Join-Path $env:ProgramFiles 'PTZ Panel'; foreach($p in @((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\PTZ Panel.lnk'),(Join-Path $env:PUBLIC 'Desktop\PTZ Panel.lnk'))){ $s=$w.CreateShortcut($p); $s.TargetPath=(Join-Path $t 'PTZ Panel.exe'); $s.WorkingDirectory=$t; $s.Save() }"

echo Apro il firewall per la telecamera (anche sulle reti pubbliche)...
netsh advfirewall firewall delete rule name="PTZ Panel" >nul 2>&1
netsh advfirewall firewall add rule name="PTZ Panel" dir=in action=allow program="%DEST%\PTZ Panel.exe" enable=yes profile=any >nul
netsh advfirewall firewall add rule name="PTZ Panel" dir=in action=allow program="%DEST%\resources\ffmpeg\ffmpeg.exe" enable=yes profile=any >nul

echo.
echo Fatto. PTZ Panel e' installato per tutti gli account di questo PC.
echo Ogni account avra' le sue inquadrature.
echo.
pause
