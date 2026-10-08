# Logs and health

Frameleaf keeps local logs, health checks and job progress. It does not collect usage telemetry or expose a Prometheus metrics listener. See [Privacy and connections](./privacy.md) for optional network requests.

Manager's **Overview** shows container health and a **Logs** action for each service. In a manual installation:

```sh
docker compose ps
docker logs --tail 100 frameleaf_server
docker logs --tail 100 frameleaf_machine_learning
docker logs --tail 100 frameleaf_postgres
```

Use **Compute & jobs** to inspect processing and **Library Care** to check your originals. Container health alone does not establish that every photo or backup is readable.

## Structured Logging

Frameleaf retains console and structured JSON logs for local troubleshooting. The application does not forward these logs to an external collector.

### Configuration

By default, Frameleaf outputs human-readable console logs. To enable JSON logging, set the `FRAMELEAF_LOG_FORMAT` environment variable:

```bash
FRAMELEAF_LOG_FORMAT=json
```

:::tip
The default is `FRAMELEAF_LOG_FORMAT=console` for human-readable logs with colors during development. For production deployments using log aggregation, use `FRAMELEAF_LOG_FORMAT=json`.
:::

### JSON Log Format

When enabled, logs are output in structured JSON format:

```json
{"level":"log","pid":36,"timestamp":1766533331507,"message":"Initialized websocket server","context":"WebsocketRepository"}
{"level":"warn","pid":48,"timestamp":1766533331629,"message":"Unable to open /build/www/index.html, skipping SSR.","context":"ApiService"}
{"level":"error","pid":36,"timestamp":1766533331690,"message":"Unable to read media file","context":"StorageService"}
```

This format includes:

- `level`: Log level (log, warn, error, etc.)
- `pid`: Process ID
- `timestamp`: Unix timestamp in milliseconds
- `message`: Log message
- `context`: Service or component that generated the log

For more information on log formats, see [`FRAMELEAF_LOG_FORMAT`](/install/environment-variables.md#general).
