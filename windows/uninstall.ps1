# 서면 YBM 네이버 예약 알림 — 제거
#   irm "https://사이트주소/windows/uninstall.ps1" | iex
& {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*naver-alert.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'YBM 네이버 예약 알림.lnk'
  Remove-Item $lnk -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $env:LOCALAPPDATA 'YBMNaverAlert') -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host '✔ 네이버 예약 알림 프로그램을 제거했습니다.' -ForegroundColor Green
}
