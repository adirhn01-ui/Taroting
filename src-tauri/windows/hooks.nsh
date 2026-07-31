; Taroting NSIS installer hooks (wired via bundle.windows.nsis.installerHooks).
; Tauri's template invokes these macros at the matching install/uninstall stage
; and exposes ${MAINBINARYNAME} (exe stem) and ${PRODUCTNAME}. The Start-menu
; shortcut is created by the template itself; here we add a Desktop shortcut and,
; on uninstall, clean up our shortcut/associations plus — only if the user ticks
; "delete app data" — every app-data dir we created (privacy-clean uninstall).
; See the gate comment on NSIS_HOOK_POSTUNINSTALL before touching that.
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
  ; TWO gates here, mirroring the template's own two gates. Do not merge them.
  ;
  ;   $UpdateMode <> 1  — "this uninstall is not one half of an update"
  ;   $DeleteAppDataCheckboxState = 1 — "the user ticked 'delete app data' on the
  ;                                      uninstaller's confirm page"
  ;
  ; $UpdateMode is set ONLY by the /UPDATE flag on the command line, which only
  ; the updater passes. A double-clicked installer that finds an older version
  ; shows the "Already Installed" page whose DEFAULT choice is "uninstall before
  ; installing"; that path runs the old uninstaller WITHOUT /UPDATE (the template
  ; appends it only ${IfThen} $UpdateMode = 1, already false there). So during an
  ; ordinary GUI upgrade $UpdateMode = 0 and anything gated on it alone RUNS.
  ; Gating the data purge on $UpdateMode alone is therefore what silently wiped
  ; settings/recents/cache on a plain double-click upgrade (the v0.7.3 bug).
  ; The checkbox is the only signal that the user actually asked for their data
  ; to go, so the purge hangs off it exactly like the template's own
  ; $APPDATA\${BUNDLEID} removal ("${If} $DeleteAppDataCheckboxState = 1
  ; ${AndIf} $UpdateMode <> 1"). $DeleteAppDataCheckboxState is a template global
  ; written only by un.ConfirmLeave; when that page never runs (silent /S or
  ; passive /P uninstall) it stays "" — numerically 0 — so those keep app data
  ; too, again matching the template. Fail-safe by construction: any path that
  ; does not explicitly ask keeps the data.
  ;
  ; Shortcuts and file associations are NOT app data and stay on the $UpdateMode
  ; gate alone, like the template's own shortcut removal: they point at $INSTDIR,
  ; which is deleted on every real uninstall regardless of the checkbox, so a
  ; leftover .trt association would double-click straight into a deleted exe.
  ; Removing them during an upgrade is harmless — the new installer recreates
  ; both moments later (APP_ASSOCIATE rewrites the keys from scratch), which is
  ; why the template likewise runs APP_UNASSOCIATE unconditionally.
  ${If} $UpdateMode <> 1
    ; Remove the desktop shortcut we created.
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
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

  ; Purge settings, recents index, encoder cache and media cache (Roaming and
  ; Local, both our folder name and the Tauri identifier folder) — ONLY when the
  ; user ticked "delete app data" and this is not an update. Same gate as the
  ; template's own app-data removal, which handles $APPDATA\com.taroting.app but
  ; not our $PRODUCTNAME-named dirs. User content in Documents\Taroting is NEVER
  ; touched.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$APPDATA\${PRODUCTNAME}"
    RMDir /r "$LOCALAPPDATA\${PRODUCTNAME}"
    RMDir /r "$APPDATA\com.taroting.app"
    RMDir /r "$LOCALAPPDATA\com.taroting.app"
  ${EndIf}
!macroend
