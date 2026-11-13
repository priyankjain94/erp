#!/bin/sh
# Make My Space - test on this Mac/Linux computer. Needs Docker Desktop running.
cd "$(dirname "$0")"
echo "Building and starting (first time takes 3-5 minutes)..."
docker compose -f docker-compose.demo.yml up -d --build || { echo "Could not start. Is Docker Desktop installed and running?"; exit 1; }
printf "Waiting for the app"
i=0; until curl -fs http://localhost:8080/api/health >/dev/null 2>&1 || [ $i -ge 60 ]; do printf "."; sleep 2; i=$((i+1)); done; echo
(open http://localhost:8080 2>/dev/null || xdg-open http://localhost:8080 2>/dev/null) &
echo "Open http://localhost:8080 - log in with 9000000001 (owner); the code is shown on screen."
echo "To stop:  docker compose -f docker-compose.demo.yml down"
