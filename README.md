# Waypoint

Waypoint is a visual manager for routes in an **existing Docker Nginx** container. Connect a domain and path to an application in the web UI, then Waypoint validates and reloads Nginx. It does not start a second public proxy or take over ports 80 and 443.

This is a v0.1 MVP for one administrator on one Docker host. It manages only routes you create in Waypoint. Your existing Nginx configuration and routes stay in place.

## What you need

- A running Nginx container on the same Docker host where you will run Waypoint. You must be able to recreate it to add a label, a shared mount, and the loader file.
- Docker Engine and Docker Compose, with access to the Docker socket. Rootless Docker users must change the socket path in `compose.yaml`.
- A Docker network shared by Nginx, Waypoint, and any application containers you want to route to. It must exist before starting Waypoint.
- Nginx must load HTTP configuration files from a directory, commonly `/etc/nginx/conf.d/*.conf`. Check with `docker exec YOUR_NGINX_CONTAINER nginx -T` before choosing where to put the loader file.

The admin page binds to `127.0.0.1:81` by default. Port 81 may already be occupied; the steps below show how to change it.

## Install beside your existing Nginx

### 1. Clone and choose the shared network

On the Docker host, clone this repository. Keep its location: Nginx and Waypoint must mount the **same** `data` directory.

```sh
git clone git@github.com:kshitijThakkar004/visual_nginx_manager.git
cd visual_nginx_manager
cp .env.example .env
```

Set `NGINX_NETWORK` in this repo's `.env` to the **actual Docker network name** that your Nginx container uses. `docker network ls` shows names. For a network called `my_proxy_network`:

```dotenv
NGINX_NETWORK=my_proxy_network
```

If port 81 is in use, set `ADMIN_PORT=8181` in the same `.env`. Keep `ADMIN_BIND=127.0.0.1` unless you have secured access to the admin UI. Set `HTTP_PORT` and `HTTPS_PORT` to Nginx's listener ports if they differ from 80 and 443.

### 2. Add the Nginx label and shared directory

Edit the Compose file that **already starts your Nginx**. Add the label and bind mount below to its existing service; keep its existing ports, volumes, environment, and networks. Replace `/absolute/path/to/visual_nginx_manager` with the absolute path where you cloned this repo.

```yaml
services:
  nginx: # replace with your existing Nginx service name
    labels:
      waypoint.nginx-target: waypoint
    volumes:
      - /absolute/path/to/visual_nginx_manager/data:/etc/nginx/waypoint
```

If your service already has `labels` or `volumes`, append these entries to the existing lists. The label lets Waypoint identify **one** Nginx container. The bind mount lets both containers see generated configuration and certificates.

### 3. Make Nginx load Waypoint's configuration

Nginx also needs to load the small file [`docker/waypoint-loader.conf`](docker/waypoint-loader.conf). Choose the option that matches your setup:

- **You already bind-mount a host `conf.d` directory:** copy the loader into that host directory as `waypoint-loader.conf`. For example, from this repo: `cp docker/waypoint-loader.conf /absolute/path/to/your/nginx/conf.d/waypoint-loader.conf`.
- **You do not bind-mount `conf.d`:** add this file mount to the same Nginx service's `volumes` list: `/absolute/path/to/visual_nginx_manager/docker/waypoint-loader.conf:/etc/nginx/conf.d/waypoint-loader.conf:ro`.

If your Nginx config loads a different directory, place or mount the loader there. The loader is one `include` line and does not replace existing configuration. Waypoint owns the generated files under `/etc/nginx/waypoint/runtime/`.

### 4. Recreate Nginx, then start Waypoint

From the directory containing your **existing Nginx Compose file**, recreate just its Nginx service so Docker applies the new label and mounts:

```sh
docker compose up -d --no-deps nginx
```

Replace `nginx` with your real service name. Then return to the cloned Waypoint directory and start its two containers:

```sh
cd /absolute/path/to/visual_nginx_manager
docker compose up --build -d
docker compose ps
```

Open `http://127.0.0.1:81` on the Docker host (or your chosen `ADMIN_PORT`) and create an admin password of at least 12 characters. For a remote server, keep the admin port bound to loopback and use an SSH tunnel:

```sh
ssh -L 8181:127.0.0.1:81 user@your-server
```

Then open `http://127.0.0.1:8181` on your computer. If you changed `ADMIN_PORT` on the server, use that port on the right side of the tunnel command.

If Nginx was started with `docker run` instead of Compose, recreate it with its original settings plus the target label and two mounts above. Docker cannot add bind mounts to an already-created container. Keep its existing network and listeners.

## Add your first route

Attach a Docker application to the same network as Waypoint and Nginx. In its Compose file, declare that existing network like this:

```yaml
services:
  notes:
    image: your-notes-image
    networks:
      - proxy

networks:
  proxy:
    external: true
    name: my_proxy_network # the same actual name used for NGINX_NETWORK
```

Open **Add route → Scan Docker services**, choose the application, and check its **container listening port** and HTTP/HTTPS protocol. Or enter a reachable hostname/IP and port manually. For a container named `notes` listening on port 3000, use `notes:3000`; it does not need a published host port. Add the public domain and path, then validate and deploy the draft. Point the domain's DNS record to the host running Nginx and ensure its public listener ports are reachable.

Do not create a Waypoint route for a domain already defined in another Nginx server block. Waypoint checks for conflicts and rejects deployment. Deploying means Nginx accepted the config and reloaded; it does not verify DNS, firewall rules, certificate validity, or application health.

## HTTPS and saved data

Waypoint v0.1 does not issue or renew certificates. Put a PEM certificate chain and private key in this repo's ignored `data` directory:

```text
data/certificates/my-domain/cert.pem
data/certificates/my-domain/key.pem
```

Reload the workspace, select `my-domain` on the domain block, and deploy. Keep certificates private and renew them yourself. For HTTPS applications behind Nginx, Waypoint verifies the upstream certificate.

The bind-mounted `data/` directory holds the admin password hash, drafts, deployment history, generated configuration, logs, and certificates. Back it up privately while Waypoint is stopped. It is excluded from Git. The `.env` file and local deployment overlays are also excluded; only `.env.example` is public.

## Check and update the installation

Use `docker compose ps` and `docker compose logs waypoint waypoint-discovery` in the Waypoint directory to inspect startup problems. If Compose reports that the external network does not exist, correct `NGINX_NETWORK` to the real network name. If scanning is unavailable, check `waypoint-discovery` logs and the Docker socket mount. If the admin page works but Nginx validation fails, check the target label, shared `data` mount, loader location, and `docker exec YOUR_NGINX_CONTAINER nginx -T`.

To update, pull new source and rebuild from the Waypoint directory:

```sh
git pull
docker compose up --build -d
```

The control agent has Docker daemon authority through the socket and can run fixed check/reload/log operations against the uniquely labeled Nginx container. The web container does not receive the socket. Use this on a Docker host you administer and keep the admin interface private.

Current limits: one host, one administrator, HTTP reverse proxying only; no ACME renewal, TCP/UDP streams, arbitrary import of existing Nginx routes, or multi-host control.

## Local development

For the frontend, use Node.js 22.13+. For the API, use Python 3.12+:

```sh
npm ci
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-dev.txt
MANAGE_NGINX=false DATA_DIR=./data-preview python -m server.index
```

In another terminal, run `npm run dev` and open `http://127.0.0.1:5173`. Preview mode lets you draft routes without changing Nginx. The production image builds the frontend and runs the FastAPI server.
