; Installer hooks for the .kerf file association.
;
; Tauri's association remembers what .kerf pointed to before ("Kerf-Projekt_backup")
; and restores it on uninstall. An update installs over Kerf, so without the
; first hook it remembers Kerf's own type, and uninstalling then leaves .kerf
; pointing to a type that no longer exists. The second hook removes what is
; left of the entry once Kerf is gone.

!macro NSIS_HOOK_PREINSTALL
  Push $0
  ReadRegStr $0 SHCTX "Software\Classes\.kerf" ""
  ${If} $0 == "Kerf-Projekt"
    ; Already installed: hand the association the type from before Kerf.
    ReadRegStr $0 SHCTX "Software\Classes\.kerf" "Kerf-Projekt_backup"
    WriteRegStr SHCTX "Software\Classes\.kerf" "" "$0"
  ${EndIf}
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Push $0
  DeleteRegValue SHCTX "Software\Classes\.kerf" "Kerf-Projekt_backup"
  ReadRegStr $0 SHCTX "Software\Classes\.kerf" ""
  ${If} $0 == ""
  ${OrIf} $0 == "Kerf-Projekt"
    DeleteRegValue SHCTX "Software\Classes\.kerf" ""
  ${EndIf}
  DeleteRegKey /ifempty SHCTX "Software\Classes\.kerf"
  Pop $0
!macroend
