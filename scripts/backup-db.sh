#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=/var/backups/vendors-hub
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)

docker exec vendors-hub-db pg_dump -U vendors -d vendors_hub | gzip > "$BACKUP_DIR/vendors_hub-$STAMP.sql.gz"

# keep 7 days
find "$BACKUP_DIR" -name 'vendors_hub-*.sql.gz' -mtime +7 -delete