; Taroting NSIS installer hooks (wired via bundle.windows.nsis.installerHooks).
; Tauri's template invokes these macros at the matching install/uninstall stage
; and exposes ${MAINBINARYNAME} (exe stem) and ${PRODUCTNAME}. The Start-menu
; shortcut is created by the template itself; here we add a Desktop shortcut and,
; on uninstall, purge every app-data dir we created (privacy-clean uninstall).
; User content in Documents\Taroting is NEVER touched.

!macro NSIS_HOOK_POSTINSTALL
  ; Desktop shortcut (currentUser install → per-user Desktop).
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove the desktop shortcut we created.
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  ; Purge settings, recents index, encoder cache and media cache. These live
  ; under the Tauri identifier folder (com.taroting.app) inside Roaming/Local.
  RMDir /r "$APPDATA\${PRODUCTNAME}"
  RMDir /r "$LOCALAPPDATA\${PRODUCTNAME}"
  RMDir /r "$APPDATA\com.taroting.app"
  RMDir /r "$LOCALAPPDATA\com.taroting.app"
!macroend
