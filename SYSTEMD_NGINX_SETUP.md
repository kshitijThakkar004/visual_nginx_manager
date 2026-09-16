# Waypoint with a systemd-managed Nginx

This guide installs Waypoint in Docker while keeping the host's existing
`nginx.service` in charge of ports 80 and 443. It follows the setup verified on
a Linux laptop running Nginx through systemd.

Waypoint does not start a second public proxy. It writes one generated Nginx
include, asks the host Nginx to validate it, and performs graceful reloads after
successful deployments.

## Resulting architecture

| Component | Where it runs | Purpose |
| --- | --- | --- |
| Host Nginx | `nginx.service` | Continues serving public traffic on ports 80 and 443. |
| Waypoint | Docker container | Provides the visual editor and writes generated configuration. |
| Discovery service | Docker container | Finds application containers and their published host ports. |
| Nginx control bridge | Root-owned systemd service | Allows only configuration check, reload, and log-reopen operations. |
| Admin interface | `127.0.0.1:81` | Keeps administration local to the laptop. |

The control bridge exists so the web application does not receive unrestricted
root or systemd access.

## 1. Check the prerequisites

Confirm that Nginx and Docker are running:

```bash
systemctl is-active nginx
docker version
docker compose version
```

The expected Nginx result is `active`. `docker version` should display both a
Client and Server section.

### If Docker reports permission denied

The Docker socket is normally owned by the `docker` group. Add your account to
that group:

```bash
sudo usermod -aG docker "$USER"
```

Log out of the Linux desktop session and log back in, then verify:

```bash
id
docker version
```

The `id` output should include `docker`. Membership in this group is effectively
root-level access because Docker can start privileged containers; grant it only
to trusted administrator accounts. Do not make the Docker socket world-writable
with `chmod 666`.

## 2. Prepare the systemd environment file

From the repository root:

```bash
cd /absolute/path/to/visual_nginx_manager
cp .env.systemd.example .env.systemd
```

The working defaults are:

```dotenv
WAYPOINT_DATA_DIR=/var/lib/waypoint
ADMIN_BIND=127.0.0.1
ADMIN_PORT=81
HTTP_PORT=80
HTTPS_PORT=443
NGINX_RESOLVER=127.0.0.53
```

Reasons for these values:

- `/var/lib/waypoint` is accessible to the host Nginx and avoids permission
  problems caused by placing runtime files under a private home directory.
- Binding the admin interface to `127.0.0.1` prevents access from other
  machines and means UFW does not need an incoming rule for port 81.
- Ports 80 and 443 describe the listeners already owned by host Nginx.
- The resolver should match a usable IPv4 resolver in `/etc/resolv.conf`.
  `127.0.0.53` is common on systems using `systemd-resolved`.

Keep `.env.systemd` private. It is excluded from Git.

## 3. Build the Waypoint image

Build the image from the repository root:

```bash
docker build -t waypoint-proxy-manager:local .
```

If Docker says Buildx is missing, use its legacy builder on installations that
still provide it:

```bash
DOCKER_BUILDKIT=0 docker build -t waypoint-proxy-manager:local .
```

Verify the result:

```bash
docker image inspect waypoint-proxy-manager:local \
  --format 'ID={{.Id}} Size={{.Size}} Created={{.Created}}'
```

Building first makes the later Compose startup deterministic and avoids giving
Compose permission to rebuild unexpectedly.

## 4. Install the host control bridge

Run the supplied installer as root:

```bash
sudo ./systemd/install-control.sh
```

The installer:

1. Detects the installed Nginx executable.
2. Creates `/var/lib/waypoint` for persistent state and generated files.
3. Installs a root-owned control program in `/usr/local/libexec`.
4. Installs and starts `waypoint-nginx-control.service`.
5. Creates `/etc/nginx/waypoint-loader.conf`.

The bridge listens only on `/run/waypoint/nginx.sock`. It accepts fixed
check/reload/reopen actions; it is not a general-purpose command shell.

If Nginx uses a unit name other than `nginx.service`, install with:

```bash
sudo NGINX_UNIT=your-nginx.service ./systemd/install-control.sh
```

Verify the bridge:

```bash
systemctl status waypoint-nginx-control --no-pager
```

It should report `active (running)`.

## 5. Include Waypoint from the host Nginx configuration

First check whether the loader is already present:

```bash
grep -n 'waypoint-loader' /etc/nginx/nginx.conf
```

If the command prints no match, make a backup:

```bash
sudo cp -a /etc/nginx/nginx.conf /etc/nginx/nginx.conf.before-waypoint
```

Open the configuration using `sudoedit`:

```bash
sudoedit /etc/nginx/nginx.conf
```

Add this line **inside the existing `http { ... }` block**, preferably beside
the other `include` directives:

```nginx
include /etc/nginx/waypoint-loader.conf;
```

Do not place it at the top level or inside a `server` block. The generated file
contains HTTP-level directives such as `log_format`, `map`, and `server`.

The loader points to:

```nginx
include /var/lib/waypoint/runtime/waypoint*.conf;
```

This separation lets Waypoint atomically replace its own generated file without
overwriting the rest of `/etc/nginx/nginx.conf`.

## 6. Validate and reload Nginx

Always test before reloading:

```bash
sudo nginx -t
```

Only after it reports that the syntax is valid, reload gracefully:

```bash
sudo systemctl reload nginx
```

A graceful reload keeps the existing worker processes serving traffic until the
new workers are ready. If validation fails, do not reload; correct the reported
configuration problem first.

## 7. Start Waypoint

Start both containers from the already-built image:

```bash
docker compose \
  --env-file .env.systemd \
  -f compose.systemd.yaml \
  up -d --no-build
```

Check their state:

```bash
docker compose \
  --env-file .env.systemd \
  -f compose.systemd.yaml \
  ps
```

The `waypoint` service should eventually show `healthy`. The discovery service
does not expose a network port; it communicates through a private Unix socket.

Confirm the API and existing Nginx listener:

```bash
curl http://127.0.0.1:81/api/health
curl -I http://127.0.0.1/
```

The Waypoint response should be:

```json
{"ok":true}
```

## 8. Complete first-time setup

Open this address on the laptop:

```text
http://127.0.0.1:81
```

Create an administrator password of at least 12 characters. Keep the admin
listener on loopback. There is no need to add UFW rules for port 81.

For remote administration, use an SSH tunnel instead of exposing the admin
port:

```bash
ssh -L 8181:127.0.0.1:81 user@server
```

Then open `http://127.0.0.1:8181` on the client computer.

## 9. Add an application route

A systemd-managed Nginx runs on the host and cannot use Docker's internal DNS
names. Docker applications must publish their HTTP port to the host, preferably
on loopback:

```yaml
services:
  notes:
    ports:
      - '127.0.0.1:3000:3000'
```

Loopback publishing lets host Nginx reach the application without exposing that
application port through UFW.

In Waypoint:

1. Select **Add route**.
2. Enter the public domain.
3. Set the path, normally `/` for the entire site.
4. Select **Scan Docker services**, or enter the destination manually.
5. Confirm the published host address and port, such as `127.0.0.1:3000`.
6. Select HTTP or HTTPS for the upstream application.
7. Validate the draft.
8. Deploy only after validation succeeds.

Do not create a Waypoint route for a domain already declared in another Nginx
server block. Waypoint detects common conflicts and leaves the previous live
configuration in place when deployment fails.

## 10. Optional end-to-end test

Start a temporary web application on host port 8080:

```bash
docker run -d \
  --name waypoint-demo \
  -p 127.0.0.1:8080:80 \
  nginx:alpine
```

Add a local test name:

```bash
echo '127.0.0.1 demo.local' | sudo tee -a /etc/hosts
```

Create this route in Waypoint:

- Domain: `demo.local`
- Path: `/`
- Destination: the scanned `waypoint-demo` service at `127.0.0.1:8080`
- Upstream protocol: HTTP
- TLS: disabled

Validate, deploy, and test:

```bash
curl http://demo.local
```

Remove the test route from Waypoint before removing its backend container:

```bash
docker rm -f waypoint-demo
```

Also remove the `demo.local` entry from `/etc/hosts` when it is no longer
needed.

## Operations

### View status and logs

```bash
systemctl status nginx waypoint-nginx-control --no-pager
docker compose --env-file .env.systemd -f compose.systemd.yaml ps
docker compose --env-file .env.systemd -f compose.systemd.yaml logs -f waypoint waypoint-discovery
```

### Restart Waypoint

```bash
docker compose --env-file .env.systemd -f compose.systemd.yaml restart
```

The bridge preserves `/run/waypoint` during service restarts so the container's
socket mount remains valid.

### Rebuild after updating the source

```bash
docker build -t waypoint-proxy-manager:local .
docker compose \
  --env-file .env.systemd \
  -f compose.systemd.yaml \
  up -d --no-build --force-recreate
```

If files under `systemd/` changed, reinstall the bridge before recreating the
containers:

```bash
sudo ./systemd/install-control.sh
```

### Stop Waypoint without stopping Nginx

```bash
docker compose --env-file .env.systemd -f compose.systemd.yaml down
```

This stops the UI and discovery containers. It does not stop `nginx.service` or
remove the last successfully loaded Nginx routes. Remove or replace deployed
routes through Waypoint before shutting it down permanently.

### Back up persistent data

Waypoint stores its state, generated configuration, deployment history, logs,
and manually installed certificates under `/var/lib/waypoint`.

Stop Waypoint before making a consistent filesystem backup:

```bash
docker compose --env-file .env.systemd -f compose.systemd.yaml stop
sudo cp -a /var/lib/waypoint /secure/backup/location/
docker compose --env-file .env.systemd -f compose.systemd.yaml start
```

Treat the backup as sensitive because it contains the administrator password
hash and may contain TLS private keys.

## Troubleshooting

### Waypoint reports Nginx disconnected or `/api/health` returns 503

Check both services and the container logs:

```bash
systemctl status nginx waypoint-nginx-control --no-pager
docker compose --env-file .env.systemd -f compose.systemd.yaml logs --tail=100 waypoint
```

Confirm the loader exists exactly once:

```bash
grep -R -n 'waypoint-loader\|/var/lib/waypoint/runtime' /etc/nginx
```

Then validate the host configuration:

```bash
sudo nginx -t
```

### The control socket is missing after reinstalling the bridge

Confirm the bridge is running, then recreate the Waypoint container so Docker
binds the current runtime directory:

```bash
systemctl is-active waypoint-nginx-control
docker compose \
  --env-file .env.systemd \
  -f compose.systemd.yaml \
  up -d --no-deps --no-build --force-recreate waypoint
```

The current unit uses `RuntimeDirectoryPreserve=restart`, so ordinary bridge
restarts should not require this workaround.

### Service scanning returns no applications

For this systemd setup, discovery lists only TCP ports published to the host.
Inspect published ports with:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

Publish the application on loopback or enter a host-reachable destination
manually in Waypoint.

### Port 81 is already in use

Change `ADMIN_PORT` in `.env.systemd`, then recreate Waypoint:

```dotenv
ADMIN_PORT=8181
```

```bash
docker compose \
  --env-file .env.systemd \
  -f compose.systemd.yaml \
  up -d --no-build --force-recreate waypoint
```

Keep `ADMIN_BIND=127.0.0.1` unless another authenticated, encrypted access layer
protects the admin interface.

## Firewall summary

For the standard local setup:

- Allow incoming TCP 80 for public HTTP traffic.
- Allow incoming TCP 443 for public HTTPS traffic.
- Do not allow incoming TCP 81; it is bound to loopback.
- Publish backend container ports on `127.0.0.1` so they are not public.

Waypoint does not modify UFW automatically.
