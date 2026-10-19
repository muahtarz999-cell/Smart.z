@echo off
chcp 65001 >nul
echo [Smart.z] Running offline unit tests...
node test-offline.mjs
pause
