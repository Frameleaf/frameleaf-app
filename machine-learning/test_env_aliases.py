import pytest

from immich_ml.env_aliases import (
    ENV_ALIASES,
    EnvAliasConflictError,
    apply_env_aliases,
    deprecated_env_warning,
    read_env,
)


def test_every_alias_keeps_its_suffix() -> None:
    for legacy, current in ENV_ALIASES:
        assert legacy.startswith("IMMICH_")
        assert current == legacy.replace("IMMICH_", "FRAMELEAF_", 1)
    assert {legacy for legacy, _ in ENV_ALIASES} >= {
        "IMMICH_HOST",
        "IMMICH_PORT",
        "IMMICH_LOG_LEVEL",
        "IMMICH_ML_AUTH_TOKEN",
    }


def test_old_name_is_copied_and_reported() -> None:
    env = {"IMMICH_PORT": "3005", "IMMICH_ML_AUTH_TOKEN": "t"}
    assert apply_env_aliases(env) == [
        ("IMMICH_PORT", "FRAMELEAF_PORT"),
        ("IMMICH_ML_AUTH_TOKEN", "FRAMELEAF_ML_AUTH_TOKEN"),
    ]
    assert env["FRAMELEAF_PORT"] == "3005"
    assert env["FRAMELEAF_ML_AUTH_TOKEN"] == "t"


def test_new_name_alone_reports_nothing() -> None:
    env = {"FRAMELEAF_PORT": "3006"}
    assert apply_env_aliases(env) == []
    assert env == {"FRAMELEAF_PORT": "3006"}


def test_equal_values_are_accepted() -> None:
    env = {"IMMICH_HOST": "::", "FRAMELEAF_HOST": "::"}
    assert apply_env_aliases(env) == [("IMMICH_HOST", "FRAMELEAF_HOST")]


def test_different_values_refuse_without_printing_them() -> None:
    env = {"IMMICH_ML_AUTH_TOKEN": "secret-a", "FRAMELEAF_ML_AUTH_TOKEN": "secret-b"}
    with pytest.raises(EnvAliasConflictError) as error:
        apply_env_aliases(env)
    assert "FRAMELEAF_ML_AUTH_TOKEN and its deprecated alias IMMICH_ML_AUTH_TOKEN" in str(error.value)
    assert "secret-" not in str(error.value)


def test_empty_value_counts_as_unset() -> None:
    env = {"IMMICH_PORT": "", "FRAMELEAF_PORT": "3006"}
    assert apply_env_aliases(env) == []
    env = {"IMMICH_PORT": "3005", "FRAMELEAF_PORT": ""}
    apply_env_aliases(env)
    assert env["FRAMELEAF_PORT"] == "3005"


def test_warning_lists_every_pair_on_one_line() -> None:
    assert deprecated_env_warning([]) is None
    message = deprecated_env_warning([("IMMICH_PORT", "FRAMELEAF_PORT"), ("IMMICH_HOST", "FRAMELEAF_HOST")])
    assert message is not None
    assert "IMMICH_PORT → FRAMELEAF_PORT" in message
    assert "IMMICH_HOST → FRAMELEAF_HOST" in message
    assert "The old names still work in this major version and stop working in the next major release." in message
    assert "\n" not in message


def test_read_env_prefers_the_new_name() -> None:
    assert read_env({"FRAMELEAF_PORT": "1", "IMMICH_PORT": "2"}, "FRAMELEAF_PORT") == "1"
    assert read_env({"IMMICH_PORT": "2"}, "FRAMELEAF_PORT") == "2"
    assert read_env({}, "FRAMELEAF_PORT", "3003") == "3003"


def test_settings_read_the_new_names(monkeypatch: pytest.MonkeyPatch) -> None:
    from immich_ml.config import NonPrefixedSettings

    monkeypatch.setenv("FRAMELEAF_HOST", "127.0.0.1")
    monkeypatch.setenv("FRAMELEAF_PORT", "3010")
    monkeypatch.setenv("FRAMELEAF_LOG_LEVEL", "debug")
    settings = NonPrefixedSettings()
    assert (settings.frameleaf_host, settings.frameleaf_port, settings.frameleaf_log_level) == (
        "127.0.0.1",
        3010,
        "debug",
    )
