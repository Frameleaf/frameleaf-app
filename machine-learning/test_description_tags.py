"""Tags derived from AI description text (FL-659)."""

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

    assert response["tags"] == ["chair", "chairs", "dog"]
