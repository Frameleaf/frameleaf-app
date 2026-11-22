"""FL-775: the generative edit quality set and its scoring sheet stay well-formed and in step."""

import hashlib
import json
from pathlib import Path
from typing import Any

from PIL import Image

ROOT = Path(__file__).parent / "test" / "generative-edit"
SIDES = ("top", "bottom", "left", "right")
MODES = {"instruct": 20, "extend": 8, "relight": 8, "sky": 6, "transfer": 8}


def load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((ROOT / name).read_text())
    return data


def check_photo(photo: dict[str, Any]) -> None:
    path = ROOT / photo["path"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == photo["sha256"], photo["path"]
    with Image.open(path) as image:
        assert image.size == (photo["width"], photo["height"]), photo["path"]
    assert photo["fixturePrompt"]


def unit_box(box: list[float]) -> bool:
    x, y, width, height = box
    return 0 <= x < 1 and 0 <= y < 1 and width > 0 and height > 0 and x + width <= 1 and y + height <= 1


def test_quality_set_is_complete() -> None:
    quality_set = load("quality-set.json")
    edits = quality_set["edits"]

    assert quality_set["gate"] == {"minAccepted": 40, "of": len(edits)}
    assert len({edit["id"] for edit in edits}) == len(edits) == 50
    assert {mode: sum(edit["mode"] == mode for edit in edits) for mode in MODES} == MODES

    for edit in edits:
        check_photo(edit["image"])
        assert edit["prompt"].strip() and edit["accept"], edit["id"]
        if "region" in edit:
            assert unit_box(edit["region"]), edit["id"]
        if edit["mode"] == "extend":
            extend = edit["extend"]
            assert extend and set(extend) <= {"aspect", *SIDES}, edit["id"]
            assert ("aspect" in extend) != any(side in extend for side in SIDES), edit["id"]
            if "aspect" in extend:
                assert all(int(part) > 0 for part in extend["aspect"].split(":")), edit["id"]
                assert extend["aspect"].count(":") == 1, edit["id"]
            else:
                assert all(0 < fraction <= 1 for fraction in extend.values()), edit["id"]
        else:
            assert "extend" not in edit, edit["id"]
        if edit["mode"] == "transfer":
            check_photo(edit["reference"])
            assert unit_box(edit["placement"]), edit["id"]
        else:
            assert "reference" not in edit and "placement" not in edit, edit["id"]


def test_scoring_sheet_matches_the_set() -> None:
    edits = load("quality-set.json")["edits"]
    sheet = load("scoring-sheet.json")

    assert [score["id"] for score in sheet["scores"]] == [edit["id"] for edit in edits]
    assert all(score["accepted"] in (True, False, None) for score in sheet["scores"])
    # The committed sheet is the blank form; a scored copy is attached to the release issue, not committed.
    assert all(score["accepted"] is None for score in sheet["scores"])
