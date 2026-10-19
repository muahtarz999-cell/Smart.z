@echo off
chcp 65001 >nul
echo ========================================================
echo   Smart.z Windows Agent - Installer & Setup
echo ========================================================
echo.
echo [1/2] Checking Node.js environment...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH! Please install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js detected.

echo.
echo [2/2] Installing required dependencies (qrcode-terminal)...
call npm install --no-audit
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   Installation completed successfully!
echo ========================================================
echo Next steps:
echo   1. Run keygen.bat to generate local Ed25519 keys.
echo   2. Run pair.bat to pair with Smart.z via QR Code.
echo   3. Run start-agent.bat to start the agent polling loop.
echo ========================================================
pause
