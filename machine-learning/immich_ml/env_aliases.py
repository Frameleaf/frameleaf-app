"""FL-294: the service's FRAMELEAF_* environment variables and their deprecated IMMICH_* aliases.

The FRAMELEAF_ name is the one to use. An old name still works: its value is copied to the new name
(once, at startup, before the settings are read) and the master process logs one warning listing the
old names in use. Two different values for one pair stop the service. An empty value counts as unset,
because Compose turns an undefined ``${VAR}`` into an empty string.
"""

from collections.abc import Mapping, MutableMapping

ENV_ALIASES: tuple[tuple[str, str], ...] = (
    ("IMMICH_HOST", "FRAMELEAF_HOST"),
    ("IMMICH_PORT", "FRAMELEAF_PORT"),
    ("IMMICH_LOG_LEVEL", "FRAMELEAF_LOG_LEVEL"),
    ("IMMICH_ML_AUTH_TOKEN", "FRAMELEAF_ML_AUTH_TOKEN"),
    ("IMMICH_SOURCE_REF", "FRAMELEAF_SOURCE_REF"),
)

_LEGACY = {current: legacy for legacy, current in ENV_ALIASES}


class EnvAliasConflictError(RuntimeError):
    def __init__(self, conflicts: list[tuple[str, str]]) -> None:
        self.conflicts = conflicts
        lines = [
            "Conflicting environment variables: each pair below is set to two different values.",
            *(f"  - {current} and its deprecated alias {legacy}" for legacy, current in conflicts),
            "Keep the FRAMELEAF_ name and remove the IMMICH_ one.",
        ]
        super().__init__("\n".join(lines))


def apply_env_aliases(env: MutableMapping[str, str]) -> list[tuple[str, str]]:
    """Copy each old name's value to its new name in place; return the old names in use."""
    deprecated: list[tuple[str, str]] = []
    conflicts: list[tuple[str, str]] = []
    for legacy, current in ENV_ALIASES:
        legacy_value = env.get(legacy, "")
        if not legacy_value:
            continue
        current_value = env.get(current, "")
        if current_value and current_value != legacy_value:
            conflicts.append((legacy, current))
            continue
        env[current] = legacy_value
        deprecated.append((legacy, current))
    if conflicts:
        raise EnvAliasConflictError(conflicts)
    return deprecated


def deprecated_env_warning(deprecated: list[tuple[str, str]]) -> str | None:
    if not deprecated:
        return None
    pairs = ", ".join(f"{legacy} → {current}" for legacy, current in deprecated)
    return (
        f"Deprecated environment variable names in use; rename them: {pairs}. "
        "The old names still work in this major version and stop working in the next major release."
    )


def read_env(env: Mapping[str, str], name: str, default: str = "") -> str:
    """A FRAMELEAF_ variable, else its deprecated IMMICH_ alias, else ``default``."""
    value = env.get(name, "")
    if value:
        return value
    legacy = _LEGACY.get(name)
    return (env.get(legacy, "") if legacy else "") or default
