"""Which Hub repositories a request may make the worker download.

CLIP, face and OCR names are closed lists and the Frameleaf models are pinned by hash, but image
description and NSFW detection take an ``owner/name`` repository from the request. Without a bound
any client of ``/predict`` could fill the model cache and saturate egress with arbitrary repositories.
A repository is downloadable when its owner is one of the task's curated owners or when a worker
administrator listed it explicitly; nothing else is fetched.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from frameleaf_ml.models.base import ModelUnavailableError

# Hub repository identifiers: an owner and a name of letters, digits, dots, dashes and underscores.
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9][\w.-]{0,95}/[A-Za-z0-9][\w.-]{0,95}$")


def repository_owner(repository: str) -> str | None:
    """The owner of a well-formed ``owner/name`` repository, else None."""
    if REPOSITORY_PATTERN.match(repository) is None:
        return None
    return repository.split("/", 1)[0]


def check_repository_trust(repository: str, *, owners: Iterable[str], trusted: Iterable[str], setting: str) -> None:
    """Refuse a repository that is neither from a curated owner nor explicitly trusted by the administrator."""
    if repository in set(trusted):
        return
    owner = repository_owner(repository)
    if owner is not None and owner.lower() in {name.lower() for name in owners}:
        return
    raise ModelUnavailableError(
        f"Model '{repository}' is not from a curated repository owner for this task. A worker administrator "
        f"must explicitly allow it in {setting} before it is downloaded."
    )
