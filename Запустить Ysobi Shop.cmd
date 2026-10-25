@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите Node.js 22.12 или новее.
  pause
  exit /b 1
)
if not exist "node_modules\telegraf\package.json" (
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo Не удалось установить зависимости. Проверьте интернет.
    pause
    exit /b 1
  )
)
node local-control.js --open --supplier-env "%USERPROFILE%\Desktop\aviedo-funpay\.env"
pause
