@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist dist call npm run build
start "" http://127.0.0.1:5178
set NODE_ENV=production
node server\index.js
