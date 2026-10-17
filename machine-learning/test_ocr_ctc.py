from pathlib import Path

import numpy as np
import pytest

from frameleaf_ml.models.ocr.ctc import CtcDecoder, greedy


@pytest.mark.parametrize("dtype", [np.float16, np.float32, np.float64])
@pytest.mark.parametrize("read_only", [False, True])
def test_decode_preserves_ctc_order_scores_and_inputs(
    dtype: type[np.float16] | type[np.float32] | type[np.float64], read_only: bool
) -> None:
    # Removing blanks before collapsing repeats would lose the second a and b.
    indices = np.array(
        [[0, 1, 1, 0, 1, 2, 3, 3], [0, 0, 0, 0, 0, 0, 0, 0], [2, 2, 0, 2, 3, 3, 1, 1], [1, 1, 0, 0, 0, 0, 0, 0]],
        dtype=np.int32,
    )
    probs = np.array(
        [
            [np.nan, 0.5, np.nan, np.nan, 0.75, 1.0, 0.75, np.nan],
            [np.nan] * 8,
            [0.5, np.nan, np.nan, 0.75, 0.25, np.nan, 0.5, np.nan],
            [np.nan] * 8,
        ],
        dtype=dtype,
    )
    # Decode a strided view, as a runtime can return non-contiguous outputs.
    index_storage = np.repeat(indices, 2, axis=1)
    prob_storage = np.repeat(probs, 2, axis=1)
    indices, probs = index_storage[:, ::2], prob_storage[:, ::2]
    expected_indices, expected_probs = index_storage.copy(), prob_storage.copy()
    if read_only:
        indices.flags.writeable = probs.flags.writeable = False

    texts, scores = CtcDecoder(["a", "b"]).decode(indices, probs)  # type: ignore[arg-type]  # Legacy float dtypes too.

    assert texts == ["aab ", "", "bb a", "a"]
    np.testing.assert_array_equal(scores, np.array([0.75, 0.0, 0.5, np.nan], dtype=dtype))
    assert scores.dtype == dtype
    np.testing.assert_array_equal(index_storage, expected_indices)
    np.testing.assert_array_equal(prob_storage, expected_probs)


@pytest.mark.parametrize("shape", [(0, 3), (2, 0), (0, 0)])
def test_decode_empty_dimensions(shape: tuple[int, int]) -> None:
    texts, scores = CtcDecoder(["a"]).decode(np.empty(shape, dtype=np.int32), np.empty(shape, dtype=np.float32))

    assert texts == [""] * shape[0]
    np.testing.assert_array_equal(scores, np.zeros(shape[0], dtype=np.float32))
    assert scores.dtype == np.float32


def test_greedy_selects_first_tied_class_and_preserves_logits() -> None:
    logits = np.array([[[0.1, 0.8, 0.8], [0.9, 0.2, 0.9]], [[0.7, 0.7, 0.2], [0.1, 0.3, 0.5]]], dtype=np.float32)
    expected_logits = logits.copy()
    logits.flags.writeable = False

    indices, probs = greedy([logits])

    np.testing.assert_array_equal(indices, [[1, 0], [0, 2]])
    np.testing.assert_array_equal(probs, np.array([[0.8, 0.9], [0.7, 0.5]], dtype=np.float32))
    assert indices.dtype == np.int32
    assert probs.dtype == np.float32
    np.testing.assert_array_equal(logits, expected_logits)


def test_greedy_reuses_in_graph_outputs() -> None:
    indices = np.array([[1, 0, 2]], dtype=np.int32)
    probs = np.array([[0.8, np.nan, 0.7]], dtype=np.float32)
    indices.flags.writeable = probs.flags.writeable = False

    actual_indices, actual_probs = greedy([indices, probs])

    assert actual_indices is indices
    assert actual_probs is probs


def test_charset_file_preserves_unicode_order_and_space(tmp_path: Path) -> None:
    charset = tmp_path / "charset.txt"
    charset.write_bytes("é\r\n猫\r\n".encode())
    decoder = CtcDecoder.from_file(charset)

    texts, scores = decoder.decode(np.array([[2, 1, 3]], dtype=np.int32), np.array([[0.5, 0.5, 0.5]], dtype=np.float32))

    assert texts == ["猫é "]
    np.testing.assert_array_equal(scores, [0.5])
    assert len(decoder) == 4


def test_charset_file_missing_or_not_a_file(tmp_path: Path) -> None:
    for path in (tmp_path / "missing.txt", tmp_path):
        with pytest.raises(FileNotFoundError):
            CtcDecoder.from_file(path)


def test_charset_file_invalid_utf8(tmp_path: Path) -> None:
    charset = tmp_path / "charset.txt"
    charset.write_bytes(b"\xff")

    with pytest.raises(UnicodeDecodeError):
        CtcDecoder.from_file(charset)
