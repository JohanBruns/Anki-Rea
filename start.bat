@echo off
title Anki Rea
cd /d "%~dp0"
start "" http://localhost:8420
node server\index.js
pause
