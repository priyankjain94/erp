#!/bin/sh
# Daily database + uploads backup. Install with:  crontab -e  →  30 2 * * * /opt/mms-platform/deploy/backup.sh
# Keeps 14 days locally. Copy BACKUP_DIR off the server (e.g. rclone to Google Drive / S3) for real safety.
set -eu
cd "$(dirname "$0")/.."
BACKUP_DIR=${BACKUP_DIR:-/var/backups/mms}
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$BACKUP_DIR"
docker compose exec -T db pg_dump -U mms -d mms --format=custom > "$BACKUP_DIR/db_$STAMP.dump"
docker compose run --rm -T --no-deps -v "$BACKUP_DIR:/backup" --entrypoint sh app -c "tar czf /backup/uploads_$STAMP.tgz -C /data uploads"
find "$BACKUP_DIR" -type f -mtime +14 -delete
echo "backup ok: $BACKUP_DIR/db_$STAMP.dump"
# Restore:  docker compose exec -T db pg_restore -U mms -d mms --clean --if-exists < db_YYYY-MM-DD_HHMM.dump
