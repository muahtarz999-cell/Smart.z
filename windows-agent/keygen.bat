@echo off
chcp 65001 >nul
echo [Smart.z] Generating local Ed25519 identity keys...
node keygen.mjs
pause
