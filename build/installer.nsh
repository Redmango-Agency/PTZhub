; Passaggi aggiuntivi dell'installer (NSIS) di PTZ Panel

!macro customInstall
  ; Regola firewall valida su tutte le reti (anche "pubbliche", tipiche delle location):
  ; serve per ricevere le risposte della telecamera e della ricerca ONVIF
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PTZ Panel"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PTZ Panel" dir=in action=allow program="$INSTDIR\PTZ Panel.exe" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PTZ Panel" dir=in action=allow program="$INSTDIR\resources\ffmpeg\ffmpeg.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PTZ Panel"'
!macroend
