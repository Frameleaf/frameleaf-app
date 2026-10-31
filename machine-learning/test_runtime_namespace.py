import importlib
import json
import pkgutil
import runpy
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from gunicorn.util import import_app, load_class


def test_runtime_namespace_and_startup_targets() -> None:
    package = importlib.import_module("frameleaf_ml")
    assert package.__file__ is not None
    package_dir = Path(package.__file__).parent
    for module in pkgutil.walk_packages(package.__path__, prefix="frameleaf_ml."):
        if module.name.endswith(".__main__"):
            continue
        importlib.import_module(module.name)

    process = MagicMock()
    process.returncode = 0
    process.__enter__.return_value = process
    with patch("subprocess.Popen", return_value=process) as spawn:
        with pytest.raises(SystemExit) as stopped:
            runpy.run_module("frameleaf_ml", run_name="__main__")
    assert stopped.value.code == 0
    command = spawn.call_args.args[0]
    assert command[3] == "frameleaf_ml.nas_app:app"
    assert import_app(command[3]) is importlib.import_module("frameleaf_ml.main").app
    assert load_class(command[command.index("-k") + 1]) is importlib.import_module(
        "frameleaf_ml.gunicorn_worker"
    ).CustomUvicornWorker
    logging_config = json.loads((package_dir / "log_conf.json").read_text())
    handler_module, handler_name = logging_config["handlers"]["console"]["class"].rsplit(".", 1)
    assert getattr(importlib.import_module(handler_module), handler_name)
