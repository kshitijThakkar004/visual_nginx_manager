FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM python:3.12-alpine AS runtime
RUN apk add --no-cache nginx ca-certificates tini
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
ENV HOST=0.0.0.0 PORT=3001 DATA_DIR=/data PROXY_HTTP_PORT=80 PROXY_HTTPS_PORT=443 NGINX_RESOLVER=127.0.0.11
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3001/api/health', timeout=3)"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["python", "-m", "server.index"]
