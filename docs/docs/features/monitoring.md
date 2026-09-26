# Monitoring

Telemetry is permanently disabled in this fork. The server contains no OpenTelemetry SDK,
exporters, instrumentation, metrics listener, or user/job metric collectors. The old
`IMMICH_TELEMETRY_INCLUDE`, `IMMICH_TELEMETRY_EXCLUDE`, and metrics-port variables cannot
re-enable reporting. The bundled Compose configurations no longer start Prometheus or Grafana.

Version checks never contact an upstream service. When they are turned on, the server asks
only Frameleaf's own GitHub releases for a newer version. Local version history, health checks,
job progress, and logs remain available.

See [Telemetry and automatic reporting](./fork-privacy-suite.md#telemetry-and-automatic-reporting)
for the machine-learning policy and the network functions that remain available.

## Structured Logging

Frameleaf retains console and structured JSON logs for local troubleshooting. The application does not forward these logs to an external collector.

### Configuration

By default, Frameleaf outputs human-readable console logs. To enable JSON logging, set the `IMMICH_LOG_FORMAT` environment variable:

```bash
IMMICH_LOG_FORMAT=json
```

:::tip
The default is `IMMICH_LOG_FORMAT=console` for human-readable logs with colors during development. For production deployments using log aggregation, use `IMMICH_LOG_FORMAT=json`.
:::

### JSON Log Format

When enabled, logs are output in structured JSON format:

```json
{"level":"log","pid":36,"timestamp":1766533331507,"message":"Initialized websocket server","context":"WebsocketRepository"}
{"level":"warn","pid":48,"timestamp":1766533331629,"message":"Unable to open /build/www/index.html, skipping SSR.","context":"ApiService"}
{"level":"error","pid":36,"timestamp":1766533331690,"message":"Failed to load plugin immich-core:","context":"Error"}
```

This format includes:

- `level`: Log level (log, warn, error, etc.)
- `pid`: Process ID
- `timestamp`: Unix timestamp in milliseconds
- `message`: Log message
- `context`: Service or component that generated the log

For more information on log formats, see [`IMMICH_LOG_FORMAT`](/install/environment-variables.md#general).
