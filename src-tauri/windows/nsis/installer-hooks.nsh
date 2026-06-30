!macro ANYBRIDGE_STOP_SIDECAR_PROCESS processName
  DetailPrint "正在停止 AnyBridge 后台代理进程: ${processName}"
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${processName}"
  !else
    nsis_tauri_utils::FindProcess "${processName}"
  !endif
  Pop $R0

  ${If} $R0 = 0
    !if "${INSTALLMODE}" == "currentUser"
      nsis_tauri_utils::KillProcessCurrentUser "${processName}"
    !else
      nsis_tauri_utils::KillProcess "${processName}"
    !endif
    Pop $R0
    Sleep 1000

    ${If} $R0 = 0
    ${OrIf} $R0 = 2
      DetailPrint "已停止 AnyBridge 后台代理进程: ${processName}"
    ${Else}
      Abort "无法停止 AnyBridge 后台代理进程 ${processName}，请退出 AnyBridge 后重试。"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ANYBRIDGE_STOP_SIDECAR_PROCESS "anybridge-proxy.exe"
  !insertmacro ANYBRIDGE_STOP_SIDECAR_PROCESS "ide-byok-proxy.exe"
!macroend
