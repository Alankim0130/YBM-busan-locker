# ============================================================
# 서면 YBM — 네이버 예약(강사 상담) 윈도우 알림 프로그램
# ------------------------------------------------------------
# 윈도우가 켜지면 자동 실행(설치 시 '시작프로그램' 등록) → 2분마다
# 사물함 사이트의 /api/naver-booking 을 읽어 직전 값과 비교하고,
# 예약이 늘면 '새 예약', 줄면 '예약 취소' 윈도우 알림을 띄운다.
#   - 처음 보는 칸은 기준선으로만 저장(알림 없음)
#   - 조회 실패한 강사는 비교하지 않음(거짓 취소 알림 방지)
#   - 직전 값: %LOCALAPPDATA%\YBMNaverAlert\snap.json
# 설치/제거는 관리자 화면 '네이버 예약' → '윈도우 프로그램' 안내를 따른다.
# Windows PowerShell 5.1(powershell.exe) 전용 — 알림에 WinRT 를 쓴다.
# ============================================================
param(
  [Parameter(Mandatory = $true)][string]$Api,
  [string]$DataDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'YBMNaverAlert' } else { Join-Path $HOME '.ybm-naver-alert' }),
  [int]$Interval = 120,
  [switch]$Once,      # 한 번만 확인하고 종료(점검용)
  [switch]$Test,      # 테스트 알림만 띄우고 종료
  [switch]$NoToast    # 알림 대신 화면에 출력(점검용)
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Site = $Api -replace '/api/naver-booking.*$', ''
$OpenUrl = "$Site/admin.html"
$SnapFile = Join-Path $DataDir 'snap.json'
$LogFile = Join-Path $DataDir 'log.txt'
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
$Week = @('일', '월', '화', '수', '목', '금', '토')

function Write-Log([string]$msg) {
  try {
    $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $msg
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    if ((Get-Item $LogFile).Length -gt 200KB) {
      $keep = Get-Content $LogFile -Encoding UTF8 | Select-Object -Last 300
      Set-Content -Path $LogFile -Value $keep -Encoding UTF8
    }
  } catch {}
}

# "2026-10-14 15:00" → "10/14(수) 15:00"
function Format-When([string]$t) {
  $d = [datetime]::ParseExact($t.Substring(0, 10), 'yyyy-MM-dd', $null)
  return ('{0}/{1}({2}) {3}' -f $d.Month, $d.Day, $Week[[int]$d.DayOfWeek], $t.Substring(11, 5))
}

function Show-Toast([string]$title, [string]$body, [string]$tag) {
  if ($NoToast) { Write-Host "[알림] $title / $body"; return }
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $e = [Security.SecurityElement]
    $lines = ($body -split "`n" | ForEach-Object { '<text>' + $e::Escape($_) + '</text>' }) -join ''
    $xml = '<toast scenario="reminder" activationType="protocol" launch="' + $e::Escape($OpenUrl) + '">' +
      '<visual><binding template="ToastGeneric"><text>' + $e::Escape($title) + '</text>' + $lines + '</binding></visual>' +
      '<actions><action content="사물함 관리 열기" activationType="protocol" arguments="' + $e::Escape($OpenUrl) + '"/>' +
      '<action content="닫기" activationType="system" arguments="dismiss"/></actions></toast>'
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    if ($tag) { $toast.Tag = ($tag -replace '[^0-9A-Za-z]', '').Substring(0, [Math]::Min(60, ($tag -replace '[^0-9A-Za-z]', '').Length)) }
    $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
  } catch {
    Write-Log ('알림 표시 실패: ' + $_.Exception.Message)
  }
}

function Get-Booking {
  $wc = New-Object Net.WebClient
  $wc.Encoding = [Text.Encoding]::UTF8
  $wc.Headers.Add('User-Agent', 'YBMNaverAlert/1.0')
  try { return ($wc.DownloadString($Api) | ConvertFrom-Json) } finally { $wc.Dispose() }
}

function Read-Snap {
  $h = @{}
  if (Test-Path $SnapFile) {
    try {
      $o = Get-Content $SnapFile -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = [int]$p.Value }
      return $h
    } catch { Write-Log '직전 기록 읽기 실패 — 기준선부터 다시 시작' }
  }
  return $null
}

function Invoke-Check {
  $data = Get-Booking
  if (-not $data -or -not $data.items) { throw '응답 형식 오류' }
  $prev = Read-Snap
  $next = @{}
  $events = New-Object System.Collections.ArrayList
  $now = [datetime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd HH:mm')
  foreach ($it in $data.items) {
    $prefix = [string]$it.id + '|'
    if (-not $it.ok) {
      # 조회 실패 → 그 강사는 직전 값 유지, 비교 안 함
      if ($prev) { foreach ($k in @($prev.Keys)) { if ($k.StartsWith($prefix)) { $next[$k] = $prev[$k] } } }
      Write-Log ("조회 실패: " + $it.name + " — " + $it.error)
      continue
    }
    foreach ($sl in @($it.slots)) {
      $k = $prefix + $sl.t
      $b = [int]$sl.b
      $next[$k] = $b
      if ($null -eq $prev -or -not $prev.ContainsKey($k)) { continue }
      $old = [int]$prev[$k]
      if ($old -eq $b -or [string]::CompareOrdinal([string]$sl.t, $now) -lt 0) { continue }
      [void]$events.Add([pscustomobject]@{ id = [string]$it.id; name = [string]$it.name; t = [string]$sl.t; booked = ($b -gt $old); diff = [Math]::Abs($b - $old); b = $b; s = [int]$sl.s })
    }
  }
  ($next | ConvertTo-Json -Compress) | Set-Content -Path $SnapFile -Encoding UTF8
  if ($null -eq $prev) { Write-Log ('기준선 저장: ' + $next.Count + '칸'); return 0 }

  if ($events.Count -gt 4) {
    $lines = $events | Select-Object -First 6 | ForEach-Object { $_.name + ' ' + (Format-When $_.t) + ' ' + $(if ($_.booked) { '예약' } else { '취소' }) }
    Show-Toast ('네이버 예약 변동 ' + $events.Count + '건') (($lines -join "`n") + $(if ($events.Count -gt 6) { "`n…" } else { '' })) ('many' + (Get-Date).Ticks)
  } else {
    foreach ($e in $events) {
      $title = $(if ($e.booked) { '📅 새 예약 · ' } else { '❌ 예약 취소 · ' }) + $e.name
      $body = (Format-When $e.t) + $(if ($e.diff -gt 1) { ' · ' + $e.diff + '건' } else { '' }) + ' (현재 ' + $e.b + '/' + $e.s + ')'
      Show-Toast $title $body ($e.id + $e.t + $e.b)
    }
  }
  foreach ($e in $events) { Write-Log ($(if ($e.booked) { '예약 ' } else { '취소 ' }) + $e.name + ' ' + $e.t + ' → ' + $e.b + '/' + $e.s) }
  return $events.Count
}

if ($Test) {
  Show-Toast '네이버 예약 알림 프로그램' '설치 완료! 예약이 추가·취소되면 이렇게 알려드려요.' 'test'
  exit 0
}
if ($Once) { $n = Invoke-Check; Write-Host "확인 완료 · 변동 $($n)건"; exit 0 }

# 중복 실행 방지
$created = $false
$mutex = New-Object Threading.Mutex($true, 'Local\YBMNaverAlert', [ref]$created)
if (-not $created) { exit 0 }

Write-Log ('시작 · ' + $Api)
$fails = 0
while ($true) {
  try {
    [void](Invoke-Check)
    if ($fails -ge 15) { Show-Toast '네이버 예약 알림' '다시 정상적으로 확인하고 있어요.' 'recovered' }
    $fails = 0
  } catch {
    $fails++
    Write-Log ('확인 실패(' + $fails + '): ' + $_.Exception.Message)
    if ($fails -eq 15) { Show-Toast '네이버 예약 알림 — 확인 안 됨' '30분째 예약 현황을 불러오지 못하고 있어요. 인터넷 연결을 확인해 주세요.' 'failing' }
  }
  Start-Sleep -Seconds $Interval
}
