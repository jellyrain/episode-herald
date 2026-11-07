!include "${BUILD_RESOURCES_DIR}\remove-program-files.nsh"
!ifndef BUILD_UNINSTALLER
  !define MUI_DIRECTORYPAGE_TEXT_TOP "请选择 C 盘以外的可写目录。追更记录和缓存将保存在程序旁边的 data 文件夹。"
  Function .onVerifyInstDir
    StrCpy $0 $INSTDIR 2
    StrCmp $0 "C:" 0 +2
      Abort
  FunctionEnd
  !macro customInit
    StrCpy $0 $INSTDIR 2
    ${If} $0 == "C:"
      StrCpy $0 $EXEDIR 2
      ${If} $0 != "C:"
        StrCpy $INSTDIR "$EXEDIR\episode-herald"
      ${ElseIf} ${FileExists} "D:\*.*"
        StrCpy $INSTDIR "D:\episode-herald"
      ${EndIf}
    ${EndIf}
    ${If} ${Silent}
      StrCpy $0 $INSTDIR 2
      ${If} $0 == "C:"
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !macroend
!endif
