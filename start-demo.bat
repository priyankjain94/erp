@echo off
REM Make My Space - test on this Windows PC. Needs Docker Desktop running.
cd /d "%~dp0"
echo Building and starting (first time takes 3-5 minutes)...
docker compose -f docker-compose.demo.yml up -d --build
if errorlevel 1 (
  echo.
  echo Could not start. Is Docker Desktop installed and running?
  pause
  exit /b 1
)
echo Waiting for the app...
timeout /t 15 /nobreak >nul
start http://localhost:8080
echo.
echo Opened http://localhost:8080  - log in with 9000000001 (owner); the code is shown on screen.
echo To stop:  docker compose -f docker-compose.demo.yml down
pause
