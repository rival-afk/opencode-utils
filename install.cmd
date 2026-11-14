@echo off
rem install.cmd - opencode-utils plugin installer for Windows (cmd.exe)
rem
rem Windows one-liner (download and run):
rem   curl -fsSL https://raw.githubusercontent.com/rival-afk/opencode-utils/main/install.cmd -o "%TEMP%\opencode-utils-install.cmd" ^&^& "%TEMP%\opencode-utils-install.cmd"
rem
rem It asks which plugins to install, downloads them from GitHub and copies
rem them into the opencode plugins directory (auto-discovered on next start).
rem
rem Non-interactive:
rem   set OPENCODE_UTILS_PLUGINS=all ^&^& curl -fsSL .../install.cmd -o "%TEMP%\ou-install.cmd" ^&^& "%TEMP%\ou-install.cmd"
rem   "%TEMP%\ou-install.cmd" /all
rem   "%TEMP%\ou-install.cmd" /plugins "no-env s-uvazheniem"
rem
rem Overrides (env or args):
rem   REF       git ref to download from (default: main)              / /ref
rem   DEST      plugins directory (default: %USERPROFILE%\.config\opencode\plugins) / /dest
rem   PLUGINS   "all" or plugin numbers/names, space-separated       / /plugins / /all

setlocal EnableExtensions EnableDelayedExpansion

set "REF=%OPENCODE_UTILS_REF%"
if not defined REF set "REF=main"
set "DEST=%OPENCODE_UTILS_PLUGINS_DIR%"
if not defined DEST set "DEST=%USERPROFILE%\.config\opencode\plugins"
set "SEL=%OPENCODE_UTILS_PLUGINS%"

set "REPO=rival-afk/opencode-utils"
set "REPO_RAW=https://raw.githubusercontent.com/%REPO%/%REF%"

set "PLUGIN1=no-env"
set "DESC1=.env readable as $VAR - contents never reach the model"
set "PLUGIN2=commands-banlist"
set "DESC2=refuse shell commands matching banlist in .config\opencode\banlist"
set "PLUGIN3=s-uvazheniem"
set "DESC3=rewrite every prompt into corporate Russian (S Uvazheniem API)"

:args
if "%~1"=="" goto done_args
if /i "%~1"=="/?" goto usage
if /i "%~1"=="/all" (set "SEL=all" & shift & goto args)
if /i "%~1"=="/plugins" (set "SEL=%~2" & shift & shift & goto args)
if /i "%~1"=="/plugins=%~2" (set "SEL=%~2" & shift & goto args)
if /i "%~1"=="/dest" (set "DEST=%~2" & shift & shift & goto args)
if /i "%~1"=="/ref" (set "REF=%~2" & shift & shift & goto args)
echo [31m%~1 is not a valid argument[0m
goto usage

:done_args

echo opencode-utils installer (repo %REPO% @ %REF%)
echo target directory: %DEST%
echo.
echo available plugins:
echo   1) %PLUGIN1%          %DESC1%
echo   2) %PLUGIN2%   %DESC2%
echo   3) %PLUGIN3%      %DESC3%
echo.

if not defined SEL (
  set /p "SEL=Select plugins (numbers/names, space-separated, 'all') [all]: "<con
  if not defined SEL set "SEL=all"
)

set "JOBS="
if /i "!SEL!"=="all" (
  set "JOBS=%PLUGIN1% %PLUGIN2% %PLUGIN3%"
) else (
  for %%T in (!SEL!) do call :pick "%%~T"
)

if not defined JOBS (
  echo nothing selected
  exit /b 1
)

if not exist "%DEST%" mkdir "%DEST%" 2>nul
if errorlevel 1 (
  echo cannot create %DEST%
  exit /b 1
)

set "FAILED=0"
for %%N in (!JOBS!) do call :install "%%~N"
echo.
if "!FAILED!"=="1" (
  echo some plugins failed to install
  exit /b 1
)
echo done. Restart opencode (or start a new session) and check:  opencode plugin list
exit /b 0

:pick
set "T=%~1"
if /i "!T!"=="1" set "T=%PLUGIN1%"
if /i "!T!"=="2" set "T=%PLUGIN2%"
if /i "!T!"=="3" set "T=%PLUGIN3%"
set "OK="
if /i "!T!"=="%PLUGIN1%" set "OK=1"
if /i "!T!"=="%PLUGIN2%" set "OK=1"
if /i "!T!"=="%PLUGIN3%" set "OK=1"
if not defined OK (
  echo unknown plugin: '!T!'
  exit /b 1
)
set "JOBS=!JOBS! !T!"
goto :eof

:install
set "NAME=%~1"
echo downloading %NAME%.js ...
call :fetch "%NAME%.js" "%REPO_RAW%/%NAME%.js" "%DEST%\%NAME%.js"
if errorlevel 1 (
  echo   FAILED to download %NAME%.js
  set "FAILED=1"
  goto :eof
)
findstr /c:"export default" "%DEST%\%NAME%.js" >nul 2>&1
if errorlevel 1 (
  echo   %NAME%.js does not look like an opencode plugin, removing
  del /q "%DEST%\%NAME%.js" 2^>nul
  set "FAILED=1"
  goto :eof
)
echo   installed -> %DEST%\%NAME%.js
goto :eof

:fetch
rem %1 = file name, %2 = url, %3 = dest
where curl >nul 2>&1
if not errorlevel 1 (
  curl -fsSL -o "%~3" "%~2"
  exit /b !errorlevel!
)
where powershell >nul 2>&1
if not errorlevel 1 (
  powershell -NoProfile -Command "try { [Net.ServicePointManager]::SecurityProtocol = 'Tls12,Tls13'; Invoke-WebRequest -UseBasicParsing '%~2' -OutFile '%~3' } catch { exit 1 }"
  exit /b !errorlevel!
)
echo neither curl nor powershell found - cannot download %~1
exit /b 1

:usage
echo usage: %~nx0 [/all] [/plugins "no-env s-uvazheniem"] [/dest DIR] [/ref REF] [/?]
echo   /all              install all plugins, no questions
echo   /plugins LIST     space-separated plugin numbers or names, e.g. "no-env s-uvazheniem"
echo   /dest DIR         plugins directory (default: %%USERPROFILE%%\.config\opencode\plugins)
echo   /ref REF          git ref to download from (default: main)
exit /b 0
