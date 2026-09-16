#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root (for example: sudo ./systemd/install-control.sh)." >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
nginx_bin=$(command -v nginx || true)
if [ -z "$nginx_bin" ]; then
  echo "nginx was not found in PATH." >&2
  exit 1
fi

install -d -m 0755 /usr/local/libexec /etc/waypoint /var/lib/waypoint
install -m 0755 "$script_dir/waypoint-systemd-control.py" /usr/local/libexec/waypoint-systemd-control
install -m 0644 "$script_dir/waypoint-nginx-control.service" /etc/systemd/system/waypoint-nginx-control.service
install -m 0644 "$script_dir/waypoint-loader.conf" /etc/nginx/waypoint-loader.conf

umask 022
printf 'NGINX_BIN=%s\nNGINX_UNIT=%s\n' "$nginx_bin" "${NGINX_UNIT:-nginx.service}" > /etc/waypoint/systemd-control.env

systemctl daemon-reload
systemctl enable waypoint-nginx-control.service
systemctl restart waypoint-nginx-control.service

echo "Installed the Waypoint Nginx control bridge."
echo "Next, include /etc/nginx/waypoint-loader.conf inside the http block in /etc/nginx/nginx.conf."
