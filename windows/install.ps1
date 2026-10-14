# 서면 YBM 네이버 예약 알림 — 설치 (관리자 화면에서 복사한 명령으로 실행)
#   $b='https://사이트주소'; irm "$b/windows/install.ps1" | iex
& {
  $ErrorActionPreference = 'Stop'
  if (-not $b) { Write-Host '사이트 주소($b)가 없습니다. 관리자 화면의 설치 명령을 그대로 복사해 붙여넣으세요.' -ForegroundColor Red; return }
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
  $site = $b.TrimEnd('/')
  $dir = Join-Path $env:LOCALAPPDATA 'YBMNaverAlert'
  $script = Join-Path $dir 'naver-alert.ps1'
  $api = "$site/api/naver-booking"
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

  Write-Host '네이버 예약 알림 프로그램을 설치합니다…' -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $dir -Force | Out-Null

  # 이미 실행 중이면 멈춤(업데이트 설치)
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*naver-alert.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $wc = New-Object Net.WebClient
  $wc.DownloadFile("$site/windows/naver-alert.ps1", $script)
  $wc.Dispose()
  try { Unblock-File $script } catch {}

  # 연결 확인
  & $ps -NoProfile -ExecutionPolicy Bypass -File $script -Api $api -Once
  if ($LASTEXITCODE -ne 0) { Write-Host '예약 현황을 불러오지 못했습니다. 인터넷 연결이나 사이트 주소를 확인하세요.' -ForegroundColor Red; return }

  # 윈도우 시작 시 자동 실행
  $args2 = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Api `"$api`""
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startup 'YBM 네이버 예약 알림.lnk'
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $ps
  $s.Arguments = $args2
  $s.WorkingDirectory = $dir
  $s.WindowStyle = 7
  $s.Description = '서면 YBM 네이버 예약 알림'
  $s.Save()

  # 지금 바로 실행 + 테스트 알림
  Start-Process -FilePath $ps -ArgumentList $args2 -WindowStyle Hidden
  & $ps -NoProfile -ExecutionPolicy Bypass -File $script -Api $api -Test

  Write-Host ''
  Write-Host '✔ 설치 완료!' -ForegroundColor Green
  Write-Host '  · 지금부터 2분마다 확인하고, 예약 추가·취소 시 오른쪽 아래에 알림이 뜹니다.'
  Write-Host '  · 윈도우를 켜면 자동으로 실행됩니다. (화면에는 보이지 않아요)'
  Write-Host '  · 방금 테스트 알림이 안 보였다면: 설정 → 시스템 → 알림 → 켬, 방해 금지 끔.'
  Write-Host '  이 창은 닫으셔도 됩니다.'
}
