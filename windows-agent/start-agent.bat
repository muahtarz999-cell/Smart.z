@echo off
chcp 65001 >nul
echo [Smart.z] Starting Windows Agent polling loop...
node agent.mjs
pause
