; Passaggi aggiuntivi dell'installer (NSIS) di PTZ Hub

!macro customInstall
  ; Regola firewall valida su tutte le reti (anche "pubbliche", tipiche delle location):
  ; serve per ricevere le risposte della telecamera e della ricerca ONVIF
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PTZ Panel"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PTZ Hub"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PTZ Hub" dir=in action=allow program="$INSTDIR\PTZ Hub.exe" enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PTZ Hub" dir=in action=allow program="$INSTDIR\resources\ffmpeg\ffmpeg.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PTZ Hub"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PTZ Panel"'
!macroend
