#!/usr/bin/env bash
# YBM 네이버 예약 알림 — 윈도우 프로그램 빌드
# 필요: mono-devel(mcs, 4.7.2 참조 어셈블리), binutils-mingw-w64-x86-64(windres)
#   Ubuntu: apt-get install mono-devel libmono-system-windows-forms4.0-cil libmono-system-web-extensions4.0-cil \
#                           libmono-system-management4.0-cil binutils-mingw-w64-x86-64
# 결과: ../download/YBM-NaverAlert.exe  (사물함 사이트에서 /download/YBM-NaverAlert.exe 로 받는다)
set -euo pipefail
cd "$(dirname "$0")"
API=/usr/lib/mono/4.7.2-api
OUT=../download/YBM-NaverAlert.exe
mkdir -p build ../download

# 아이콘·실행 권한(관리자 X)·고해상도·파일 정보
x86_64-w64-mingw32-windres --preprocessor=cpp --codepage=65001 -i res/app.rc -O res -o build/app.res

RES=""
for s in 16 20 24 32 40 48 64; do RES="$RES -resource:res/icon$s.png,icon$s.png"; done

mcs -target:winexe -platform:anycpu -optimize+ -codepage:utf8 -warnaserror+ \
  -nostdlib -noconfig -lib:$API -lib:$API/Facades \
  -r:mscorlib.dll -r:System.dll -r:System.Core.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll \
  -r:System.Web.Extensions.dll -r:System.Management.dll \
  -win32res:build/app.res $RES \
  -out:$OUT src/*.cs

mono "$OUT" /selftest
ls -la "$OUT"
sha256sum "$OUT"
