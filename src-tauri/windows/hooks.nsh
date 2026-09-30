; Taroting NSIS installer hooks (wired via bundle.windows.nsis.installerHooks).
; Tauri's template invokes these macros at the matching install/uninstall stage
; and exposes ${MAINBINARYNAME} (exe stem) and ${PRODUCTNAME}. The Start-menu
; shortcut is created by the template itself; here we add a Desktop shortcut,
; the media "Open with" registration and the Default-apps listing, and, on
; uninstall, clean up our shortcut/associations plus — only if the user ticks
; "delete app data" — every app-data dir we created (privacy-clean uninstall).
; See the gate comment on NSIS_HOOK_POSTUNINSTALL before touching that.
; User content in Documents\Taroting is NEVER touched.
;
; TAROTING NEVER CLAIMS A MEDIA DEFAULT. The only default it owns is .trt (the
; template's APP_ASSOCIATE, from tauri.conf.json's one fileAssociations entry).
; Media gets exactly two things, neither of which changes what a double-click
; opens: an OpenWithProgids value per extension (Explorer's "Open with" list)
; and a Capabilities\FileAssociations row (Settings -> Default apps lists
; Taroting as a CHOICE). Only the user's own pick in Windows' UI (UserChoice)
; can make Taroting the default for a video, photo or song.
;
; The ProgIDs Taroting.Video / Taroting.Image / Taroting.Audio and
; "Taroting Project" are FOREVER names: a UserChoice may reference them, so a
; rename orphans it. All new keys are written through SHCTX, which is HKCU while
; installMode is currentUser (media-extensions.test.ts pins that pairing, and
; the literal HKCU lines below rely on it).
;
; Legacy: 0.6.0-0.8.1 listed ten media types in fileAssociations, so the
; template made "Media file" their HKCU DEFAULT (and clobbered the backup on
; every upgrade). That residue is migrated away in POSTINSTALL, not in the
; uninstall hook, because most upgrade paths never run the old uninstaller:
; "Do not uninstall", same-version "Add/Reinstall", /UPDATE and silent /S all
; install OVER the old keys (only the GUI default radio uninstalls first).

; A Taroting media ProgID: its Explorer "Type" text, the exe icon and a quoted
; open command. No verb label: Windows localises "Open" itself. Install only.
!macro TRT_PROGID PROGID DESC
  WriteRegStr SHCTX "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

; "Open with -> Taroting" for one extension: a zero-length REG_NONE value named
; after the ProgID (the shape Windows writes for store apps). Never touches the
; .ext default value — that is the no-steal rule.
!macro TRT_OPENWITH_ADD EXT PROGID
  WriteRegNone SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
!macroend

; Removes only OUR value; the keys go only if nothing else lives in them
; (/ifempty = no subkeys AND no values — a set default counts as a value), so
; another app's OpenWithProgids entry or default is never collateral.
!macro TRT_OPENWITH_REMOVE EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}"
!macroend

; One Settings -> Default apps row: "Taroting can open .<ext> as <ProgID>". It
; offers Taroting there; it sets nothing. Install only — the uninstall removes
; the whole Capabilities key, which is entirely ours.
!macro TRT_CAPABILITY EXT PROGID
  WriteRegStr SHCTX "Software\Taroting\Capabilities\FileAssociations" ".${EXT}" "${PROGID}"
!macroend

; Legacy owner check: $R9 = 1 when the "Media file" ProgID is ours (its command
; is this install's exe, quoted or as the template wrote it, unquoted) or is
; already gone. Anything else — a moved install dir, another program that
; happens to use the name — is left alone.
!macro TRT_LEGACY_OWNER
  StrCpy $R9 0
  ClearErrors
  ReadRegStr $R0 SHCTX "Software\Classes\Media file\shell\open\command" ""
  ${If} ${Errors}
    StrCpy $R9 1
  ${ElseIf} $R0 == '$INSTDIR\${MAINBINARYNAME}.exe "%1"'
    StrCpy $R9 1
  ${ElseIf} $R0 == '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
    StrCpy $R9 1
  ${EndIf}
!macroend

; Undo one legacy "Media file" default. The backup is trusted only when it is
; non-empty, is not our own name (the upgrade clobber) and still names a ProgID
; that exists (HKCR = HKCU+HKLM merged; EnumRegKey sets the error flag when the
; key cannot be opened); otherwise the default is deleted and Windows falls back
; to UserChoice / its own handler. The old APP_UNASSOCIATE wrote a SET-but-empty
; default when its backup was "", which reads as "no handler" — dropped too.
; This is the ONE place hooks.nsh may write a .ext default value, and only to
; hand back what was there before Taroting (media-extensions.test.ts pins it).
!macro TRT_MIGRATE_LEGACY EXT
  ${If} $R9 = 1
    ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
    ${If} $R0 == "Media file"
      ReadRegStr $R1 SHCTX "Software\Classes\.${EXT}" "Media file_backup"
      StrCpy $R2 ""
      ${If} $R1 != ""
      ${AndIf} $R1 != "Media file"
        ClearErrors
        EnumRegKey $R3 HKCR "$R1" 0
        ${IfNot} ${Errors}
          StrCpy $R2 $R1
        ${EndIf}
      ${EndIf}
      ${If} $R2 != ""
        WriteRegStr SHCTX "Software\Classes\.${EXT}" "" $R2
      ${Else}
        DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
      ${EndIf}
    ${EndIf}
    ClearErrors
    ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
    ${IfNot} ${Errors}
    ${AndIf} $R0 == ""
      DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
    ${EndIf}
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" "Media file_backup"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Desktop shortcut (currentUser install → per-user Desktop).
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; The template writes the .trt command with the exe UNQUOTED; under a profile
  ; path with a space the exe path itself splits into two argv entries. Rewrite
  ; it quoted, on every install path.
  WriteRegStr SHCTX "Software\Classes\Taroting Project\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Legacy "Media file" defaults (header). FROZEN list — exactly what 0.6.0-0.8.1
  ; claimed; never derive it from media-extensions.json.
  !insertmacro TRT_LEGACY_OWNER
  !insertmacro TRT_MIGRATE_LEGACY "mp4"
  !insertmacro TRT_MIGRATE_LEGACY "mov"
  !insertmacro TRT_MIGRATE_LEGACY "mkv"
  !insertmacro TRT_MIGRATE_LEGACY "avi"
  !insertmacro TRT_MIGRATE_LEGACY "webm"
  !insertmacro TRT_MIGRATE_LEGACY "gif"
  !insertmacro TRT_MIGRATE_LEGACY "mp3"
  !insertmacro TRT_MIGRATE_LEGACY "wav"
  !insertmacro TRT_MIGRATE_LEGACY "flac"
  !insertmacro TRT_MIGRATE_LEGACY "aac"
  ${If} $R9 = 1
    DeleteRegKey SHCTX "Software\Classes\Media file"
  ${EndIf}

  ; Media ProgIDs. gif is video: it has motion.
  !insertmacro TRT_PROGID "Taroting.Video" "Taroting video"
  !insertmacro TRT_PROGID "Taroting.Image" "Taroting image"
  !insertmacro TRT_PROGID "Taroting.Audio" "Taroting audio"

  ; "Open with -> Taroting", one line per media-extensions.json entry, in its
  ; order (media-extensions.test.ts holds this list to the JSON).
  !insertmacro TRT_OPENWITH_ADD "mp4" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "m4v" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "mov" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "mkv" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "avi" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "webm" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "wmv" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "mts" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "m2ts" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "3gp" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "mpg" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "mpeg" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "gif" "Taroting.Video"
  !insertmacro TRT_OPENWITH_ADD "png" "Taroting.Image"
  !insertmacro TRT_OPENWITH_ADD "jpg" "Taroting.Image"
  !insertmacro TRT_OPENWITH_ADD "jpeg" "Taroting.Image"
  !insertmacro TRT_OPENWITH_ADD "webp" "Taroting.Image"
  !insertmacro TRT_OPENWITH_ADD "bmp" "Taroting.Image"
  !insertmacro TRT_OPENWITH_ADD "mp3" "Taroting.Audio"
  !insertmacro TRT_OPENWITH_ADD "wav" "Taroting.Audio"
  !insertmacro TRT_OPENWITH_ADD "flac" "Taroting.Audio"
  !insertmacro TRT_OPENWITH_ADD "aac" "Taroting.Audio"
  !insertmacro TRT_OPENWITH_ADD "m4a" "Taroting.Audio"
  !insertmacro TRT_OPENWITH_ADD "ogg" "Taroting.Audio"

  ; Settings -> Default apps listing. Software\Taroting is also the template's
  ; MANUKEY (Software\${MANUFACTURER}, from bundle.publisher — the test pins it
  ; to "Taroting"); its Taroting subkey is the template's, Capabilities is ours.
  WriteRegStr SHCTX "Software\Taroting\Capabilities" "ApplicationName" "Taroting"
  WriteRegStr SHCTX "Software\Taroting\Capabilities" "ApplicationDescription" "Free, offline video and image editor"
  WriteRegStr SHCTX "Software\Taroting\Capabilities" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  !insertmacro TRT_CAPABILITY "trt" "Taroting Project"
  !insertmacro TRT_CAPABILITY "mp4" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "m4v" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "mov" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "mkv" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "avi" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "webm" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "wmv" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "mts" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "m2ts" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "3gp" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "mpg" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "mpeg" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "gif" "Taroting.Video"
  !insertmacro TRT_CAPABILITY "png" "Taroting.Image"
  !insertmacro TRT_CAPABILITY "jpg" "Taroting.Image"
  !insertmacro TRT_CAPABILITY "jpeg" "Taroting.Image"
  !insertmacro TRT_CAPABILITY "webp" "Taroting.Image"
  !insertmacro TRT_CAPABILITY "bmp" "Taroting.Image"
  !insertmacro TRT_CAPABILITY "mp3" "Taroting.Audio"
  !insertmacro TRT_CAPABILITY "wav" "Taroting.Audio"
  !insertmacro TRT_CAPABILITY "flac" "Taroting.Audio"
  !insertmacro TRT_CAPABILITY "aac" "Taroting.Audio"
  !insertmacro TRT_CAPABILITY "m4a" "Taroting.Audio"
  !insertmacro TRT_CAPABILITY "ogg" "Taroting.Audio"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Taroting" "Software\Taroting\Capabilities"

  ; Tell Explorer associations changed (the template defines this macro but
  ; never inserts it). SHCNF_FLUSH is synchronous; a hung shell extension is
  ; not a reason to drop the call. Keep it last.
  !insertmacro UPDATEFILEASSOC
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
  ; both moments later (APP_ASSOCIATE and our POSTINSTALL rewrite the keys from
  ; scratch), which is why the template likewise runs APP_UNASSOCIATE
  ; unconditionally. The Open-with values, the Taroting.* ProgIDs and the
  ; Default-apps listing point into $INSTDIR the same way, so they share the gate.
  ${If} $UpdateMode <> 1
    ; Remove the desktop shortcut we created.
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ; Association residue (see TRT_CLEAN_EXT above). Media has no default to
    ; clean: Taroting never claims one (header).
    !insertmacro TRT_CLEAN_EXT "trt" "Taroting Project"
    ; .trt is Taroting's own extension — if nothing else claimed it, remove the
    ; emptied key entirely. The template's restore writes an empty-string default
    ; (a SET value, which defeats /ifempty), so drop an empty default first.
    ReadRegStr $R0 HKCU "Software\Classes\.trt" ""
    ${If} $R0 == ""
      DeleteRegValue HKCU "Software\Classes\.trt" ""
    ${EndIf}
    DeleteRegKey /ifempty HKCU "Software\Classes\.trt"

    ; Our Open-with values only; other apps' entries stay (TRT_OPENWITH_REMOVE).
    !insertmacro TRT_OPENWITH_REMOVE "mp4" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "m4v" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "mov" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "mkv" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "avi" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "webm" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "wmv" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "mts" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "m2ts" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "3gp" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "mpg" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "mpeg" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "gif" "Taroting.Video"
    !insertmacro TRT_OPENWITH_REMOVE "png" "Taroting.Image"
    !insertmacro TRT_OPENWITH_REMOVE "jpg" "Taroting.Image"
    !insertmacro TRT_OPENWITH_REMOVE "jpeg" "Taroting.Image"
    !insertmacro TRT_OPENWITH_REMOVE "webp" "Taroting.Image"
    !insertmacro TRT_OPENWITH_REMOVE "bmp" "Taroting.Image"
    !insertmacro TRT_OPENWITH_REMOVE "mp3" "Taroting.Audio"
    !insertmacro TRT_OPENWITH_REMOVE "wav" "Taroting.Audio"
    !insertmacro TRT_OPENWITH_REMOVE "flac" "Taroting.Audio"
    !insertmacro TRT_OPENWITH_REMOVE "aac" "Taroting.Audio"
    !insertmacro TRT_OPENWITH_REMOVE "m4a" "Taroting.Audio"
    !insertmacro TRT_OPENWITH_REMOVE "ogg" "Taroting.Audio"
    DeleteRegKey SHCTX "Software\Classes\Taroting.Video"
    DeleteRegKey SHCTX "Software\Classes\Taroting.Image"
    DeleteRegKey SHCTX "Software\Classes\Taroting.Audio"

    ; Default-apps listing. Capabilities is wholly ours; its parent is the
    ; template's MANUKEY, whose Taroting subkey (install dir, installer
    ; language) the template removes only when app data is purged — so the
    ; parent goes only if nothing is left in it, never outright.
    DeleteRegValue SHCTX "Software\RegisteredApplications" "Taroting"
    DeleteRegKey SHCTX "Software\Taroting\Capabilities"
    DeleteRegKey /ifempty SHCTX "Software\Taroting"

    !insertmacro UPDATEFILEASSOC
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
