; The association uses the application's branded icon. Quote both paths so an
; installation folder or a project filename containing spaces remains unambiguous.
; electron-builder invokes this after its generated registerFileAssociations macro.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\GarakIeum.Project\DefaultIcon" "" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\GarakIeum.Project\shell\open\command" "" '"$appExe" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

; Do not leave our now-missing ProgID as the extension default. Another app's
; later selection is preserved; Windows UserChoice is never edited here.
!macro customUnInstall
  Push $0
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.garak" ""
  ${If} $0 == "GarakIeum.Project"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.garak" ""
  ${EndIf}
  Pop $0
!macroend
