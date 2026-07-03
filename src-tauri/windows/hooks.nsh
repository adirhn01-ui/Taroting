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

; Post-uninstall association cleanup for one extension. The template's
; APP_UNASSOCIATE restores the "<progid>_backup" default but (a) leaves the
; backup value behind and (b) after an UPGRADE the backup was clobbered with our
; own progid (APP_ASSOCIATE re-ran while we were the default), so the "restored"
; default dangles on a progid the uninstall just deleted. Clear such dangling
; defaults (Windows' per-user UserChoice governs double-click anyway) and drop
; the stale backup value.
!macro TRT_CLEAN_EXT EXT PROGID
  ReadRegStr $R0 HKCU "Software\Classes\.${EXT}" ""
  ${If} $R0 == "${PROGID}"
    DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
  ${EndIf}
  DeleteRegValue HKCU "Software\Classes\.${EXT}" "${PROGID}_backup"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; During an UPGRADE the template runs the old uninstaller in update mode
  ; ($UpdateMode = 1) — settings/recents/cache must survive that, so the whole
  ; purge is gated exactly like the template's own app-data removal.
  ${If} $UpdateMode <> 1
    ; Remove the desktop shortcut we created.
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ; Purge settings, recents index, encoder cache and media cache (Roaming and
    ; Local, both our folder name and the Tauri identifier folder).
    RMDir /r "$APPDATA\${PRODUCTNAME}"
    RMDir /r "$LOCALAPPDATA\${PRODUCTNAME}"
    RMDir /r "$APPDATA\com.taroting.app"
    RMDir /r "$LOCALAPPDATA\com.taroting.app"
    ; Association residue (see TRT_CLEAN_EXT above).
    !insertmacro TRT_CLEAN_EXT "trt" "Taroting Project"
    !insertmacro TRT_CLEAN_EXT "mp4" "Media file"
    !insertmacro TRT_CLEAN_EXT "mov" "Media file"
    !insertmacro TRT_CLEAN_EXT "mkv" "Media file"
    !insertmacro TRT_CLEAN_EXT "avi" "Media file"
    !insertmacro TRT_CLEAN_EXT "webm" "Media file"
    !insertmacro TRT_CLEAN_EXT "gif" "Media file"
    !insertmacro TRT_CLEAN_EXT "mp3" "Media file"
    !insertmacro TRT_CLEAN_EXT "wav" "Media file"
    !insertmacro TRT_CLEAN_EXT "flac" "Media file"
    !insertmacro TRT_CLEAN_EXT "aac" "Media file"
    ; .trt is Taroting's own extension — if nothing else claimed it, remove the
    ; emptied key entirely. The template's restore writes an empty-string default
    ; (a SET value, which defeats /ifempty), so drop an empty default first.
    ReadRegStr $R0 HKCU "Software\Classes\.trt" ""
    ${If} $R0 == ""
      DeleteRegValue HKCU "Software\Classes\.trt" ""
    ${EndIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.trt"
  ${EndIf}
!macroend
