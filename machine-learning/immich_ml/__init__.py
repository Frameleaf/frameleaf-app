from .privacy import disable_telemetry

# Package initialization runs before every entry point, including Gunicorn workers,
# direct ASGI imports, model utilities and tests. Container defaults alone can be
# overridden and are too late for libraries that cache their settings on import.
disable_telemetry()
