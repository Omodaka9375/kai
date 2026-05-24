; "Open in KAI" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInKAI" "" "Open in KAI"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInKAI" "Icon" '"$INSTDIR\KAI.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInKAI" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInKAI\command" "" '"$INSTDIR\KAI.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInKAI" "" "Open in KAI"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInKAI" "Icon" '"$INSTDIR\KAI.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInKAI" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInKAI\command" "" '"$INSTDIR\KAI.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInKAI" "" "Open in KAI"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInKAI" "Icon" '"$INSTDIR\KAI.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInKAI" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInKAI\command" "" '"$INSTDIR\KAI.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInKAI"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInKAI"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInKAI"
!macroend
