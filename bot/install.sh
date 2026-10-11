#!/usr/bin/env bash
# Instala TaskBot como servicio de usuario systemd (arranca con la PC).
set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="taskbot.service"

if [[ ! -f "$BOT_DIR/.env" ]]; then
  echo "✖ Falta $BOT_DIR/.env — copiá .env.example y completalo:"
  echo "    cp $BOT_DIR/.env.example $BOT_DIR/.env"
  exit 1
fi

if ! grep -qE '^TELEGRAM_BOT_TOKEN=.+' "$BOT_DIR/.env"; then
  echo "✖ TELEGRAM_BOT_TOKEN vacío en $BOT_DIR/.env"
  exit 1
fi

mkdir -p "$UNIT_DIR"
NODE_DIR="$(dirname "$(readlink -f "$(command -v node)")")"
sed "s#@REPO_DIR@#$(dirname "$BOT_DIR")#g; s#@NODE_DIR@#$NODE_DIR#g" \
  "$BOT_DIR/systemd/$UNIT" > "$UNIT_DIR/$UNIT"

# Sin linger, los servicios de usuario mueren al cerrar sesión y no arrancan en boot.
if ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -q yes; then
  echo "→ habilitando linger (requiere sudo una sola vez)"
  sudo loginctl enable-linger "$USER"
fi

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
sleep 2
systemctl --user --no-pager status "$UNIT" | head -15

echo
echo "✔ Listo. Logs en vivo:  journalctl --user -u $UNIT -f"
