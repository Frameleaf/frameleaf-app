"""Tags derived from AI description text (FL-659)."""

import json
from contextlib import nullcontext
from types import SimpleNamespace

from PIL import Image

from frameleaf_ml.models.florence_manifest import FLORENCE_MODELS
from frameleaf_ml.models.image_description import TAG_LIMIT, ImageDescriptionModel, tags_from_text


def test_drops_pronouns_prepositions_numbers_colours_and_framing_words():
    text = (
        "The image shows four people standing in front of a white table. A woman wearing her red coat sits "
        "behind them, and his dog is beside its bowl at the top of the photo with 2 cakes and 30 candles."
    )

    assert tags_from_text(text) == ["people", "table", "woman", "coat", "dog", "bowl", "cakes", "candles"]


def test_drops_short_tokens_digits_and_possessives_and_deduplicates():
    assert tags_from_text("A cat, a CAT and the cat's toy on an A4 sheet near 4k tv; Alberta driver's licence") == [
        "cat",
        "toy",
        "sheet",
        "alberta",
        "driver",
        "licence",
    ]


def test_keeps_hyphenated_nouns_and_caps_the_count():
    assert tags_from_text("hot-air balloon over sand-dunes")[:2] == ["hot-air", "balloon"]
    words = " ".join(f"noun{letter}" for letter in "abcdefghijklmnopqrstuvwxyz")
    assert len(tags_from_text(words)) == TAG_LIMIT


def test_model_paths_use_the_filter(tmp_path):
    model = ImageDescriptionModel(next(iter(FLORENCE_MODELS)), acceleration="cuda", device="cpu", cache_dir=tmp_path)

    response = model._normalize_response(
        '{"description": "Her dog sits behind four white chairs in the image.", "objects": ["dog", "chair"]}'
    )

    assert response["tags"] == ["dog", "chair", "chairs"]


def test_safety_tags_and_detector_labels_survive_the_twenty_tag_cut(tmp_path):
    model = ImageDescriptionModel(next(iter(FLORENCE_MODELS)), acceleration="cuda", device="cpu", cache_dir=tmp_path)
    caption = " ".join(f"thing{letter}" for letter in "abcdefghijklmnopqrstuvwxy")
    response = model._normalize_response(
        json.dumps(
            {
                "description": caption,
                "objects": ["zebra", "yacht"],
                "medical": {"is_medical_likely": True, "indicators": ["hospital"]},
            }
        )
    )

    assert len(response["tags"]) == TAG_LIMIT
    assert response["tags"][:4] == ["medical", "hospital", "zebra", "yacht"]


def test_nsfw_tags_survive_the_twenty_tag_cut_ahead_of_ordinary_tags(tmp_path):
    model = ImageDescriptionModel(next(iter(FLORENCE_MODELS)), acceleration="cuda", device="cpu", cache_dir=tmp_path)
    caption = " ".join(f"thing{letter}" for letter in "abcdefghijklmnopqrstuvwxy")
    response = model._normalize_response(
        json.dumps(
            {
                "description": caption,
                "objects": ["zebra"],
                "safety": {"is_nsfw_likely": True, "confidence": "high", "indicators": ["naked", "explicit"]},
            }
        )
    )

    assert len(response["tags"]) == TAG_LIMIT
    assert response["tags"][:4] == ["naked", "explicit", "nsfw", "zebra"]


def test_model_tags_keep_their_order_after_signal_tags_and_are_cut_at_twenty(tmp_path):
    model = ImageDescriptionModel(next(iter(FLORENCE_MODELS)), acceleration="cuda", device="cpu", cache_dir=tmp_path)
    own_tags = ["Zebra", "yacht", "zebra", *(f"thing{letter}" for letter in "abcdefghijklmnopqrstuvwxy")]
    response = model._normalize_response(
        json.dumps(
            {
                "description": "A zebra by a yacht.",
                "tags": own_tags,
                "safety": {"is_nsfw_likely": True, "confidence": "high", "indicators": ["naked"]},
                "medical": {"is_medical_likely": True, "indicators": ["hospital"]},
            }
        )
    )

    # The model's own tags are used as given (not filtered from the text), after the signal tags,
    # de-duplicated case-insensitively, and the list is cut at 20.
    assert response["tags"][:7] == ["naked", "nsfw", "medical", "hospital", "zebra", "yacht", "thinga"]
    assert len(response["tags"]) == TAG_LIMIT
    assert len(set(response["tags"])) == TAG_LIMIT


def test_drops_words_with_digits_whole_and_contractions():
    assert tags_from_text("A 3d-rendering and 3d_model of a kite; they're sure it's fine, don't worry") == [
        "kite",
        "sure",
        "fine",
        "worry",
    ]


def test_keeps_detector_labels_whole_even_when_they_are_colour_words():
    assert tags_from_text("an orange on a white plate", labels=["orange", "dining table", "x", "4k tv"]) == [
        "orange",
        "dining-table",
        "plate",
    ]


def test_florence_detector_labels_win_the_tag_budget(tmp_path):
    model = ImageDescriptionModel(next(iter(FLORENCE_MODELS)), acceleration="cuda", device="cpu", cache_dir=tmp_path)
    model.session = {"torch": SimpleNamespace(inference_mode=nullcontext)}
    caption = " ".join(f"thing{letter}" for letter in "abcdefghijklmnopqrstuvwxy")
    outputs = {
        "<MORE_DETAILED_CAPTION>": {"<MORE_DETAILED_CAPTION>": caption},
        "<OCR>": {"<OCR>": "sign"},
        "<OD>": {"<OD>": {"labels": ["chair", "orange"]}},
    }
    model._run_florence_task = lambda task, image: outputs[task]  # type: ignore[method-assign]

    tags = model._predict_florence(Image.new("RGB", (4, 4)))["tags"]

    assert tags[:3] == ["chair", "orange", "thinga"]
    assert len(tags) == TAG_LIMIT
