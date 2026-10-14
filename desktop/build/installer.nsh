; Paperwing installer additions (included by electron-builder's NSIS script)
;
; File Explorer thumbnails for PDFs: registers resources\thumbnails\
; PaperwingThumbnails.dll (see native/win-thumbnails) as the thumbnail
; provider of Paperwing's PDF file type, so Explorer shows the first page while
; Paperwing is the default PDF app. Per-user, like the rest of the install.

!define PW_THUMB_CLSID "{4EB59494-E569-4EDF-B77F-06CEDDC45EE2}"
!define PW_THUMB_DLL "$INSTDIR\resources\thumbnails\PaperwingThumbnails.dll"
; Paperwing's PDF file type: the fileAssociations name in electron-builder.yml
!define PW_PDF_PROGID "PDF Document"
; IThumbnailProvider handler key
!define PW_THUMB_HANDLER "{e357fccd-a995-4576-b01f-234630154e96}"

!macro pwNotifyAssocChanged
  ; SHCNE_ASSOCCHANGED, SHCNF_FLUSH: Explorer reloads file type handlers
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend

!macro customInstall
  ${if} ${FileExists} "${PW_THUMB_DLL}"
    WriteRegStr SHELL_CONTEXT "Software\Classes\CLSID\${PW_THUMB_CLSID}" "" "Paperwing PDF thumbnails"
    WriteRegStr SHELL_CONTEXT "Software\Classes\CLSID\${PW_THUMB_CLSID}\InprocServer32" "" "${PW_THUMB_DLL}"
    WriteRegStr SHELL_CONTEXT "Software\Classes\CLSID\${PW_THUMB_CLSID}\InprocServer32" "ThreadingModel" "Apartment"
    WriteRegStr SHELL_CONTEXT "Software\Classes\${PW_PDF_PROGID}\ShellEx\${PW_THUMB_HANDLER}" "" "${PW_THUMB_CLSID}"
    !insertmacro pwNotifyAssocChanged
  ${endif}
!macroend

!macro customUnInstall
  ; Explorer stops using the provider...
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PW_PDF_PROGID}\ShellEx\${PW_THUMB_HANDLER}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\CLSID\${PW_THUMB_CLSID}"
  !insertmacro pwNotifyAssocChanged
  ; ...but its thumbnail process may still have the DLLs loaded. A loaded DLL
  ; can't be deleted, which would make the uninstall (and every update, which
  ; uninstalls the old version first) fail, but it can be moved: move them to
  ; the temp folder, where Windows cleans them up later.
  ${if} ${FileExists} "$INSTDIR\resources\thumbnails\*.*"
    GetTempFileName $R9
    Delete $R9
    CreateDirectory $R9
    Rename "$INSTDIR\resources\thumbnails\PaperwingThumbnails.dll" "$R9\PaperwingThumbnails.dll"
    Rename "$INSTDIR\resources\thumbnails\pdfium.dll" "$R9\pdfium.dll"
    ; Deleted now if nothing has them loaded
    Delete "$R9\PaperwingThumbnails.dll"
    Delete "$R9\pdfium.dll"
    RMDir $R9
  ${endif}
!macroend
