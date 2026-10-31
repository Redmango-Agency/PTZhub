; Solo per il collaudo in Wine: il controllo "app in esecuzione" dà un falso positivo
; perché Wine non ha PowerShell. Non viene usato nella build pubblicata.
!include "${BUILD_RESOURCES_DIR}\installer.nsh"
!macro customCheckAppRunning
!macroend
