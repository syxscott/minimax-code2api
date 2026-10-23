@echo off
rem minimax-code2api launcher (double-click or run from any shell)
rem Prerequisite: MiniMax Code desktop app running and logged in.
cd /d "%~dp0"
node src\server.js
