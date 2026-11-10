#!/bin/bash
# Локальный сервер для МАССИНГа.
# Через file:// не заработает: ES-модули и запросы к Overpass требуют http-происхождения.
cd "$(dirname "$0")" || exit 1
PORT=${1:-8765}
command -v open >/dev/null && (sleep 1 && open "http://localhost:$PORT") &
exec python3 serve.py "$PORT"
