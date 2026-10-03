"""Explicit administrator provisioning; verification is offline unless --download is supplied."""
import argparse
import json
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', help='Explicitly fetch only the manifest-pinned files')
    parser.add_argument('--cache-root', type=Path, default=Path(os.environ.get('MACHINE_LEARNING_CACHE_FOLDER', '/cache')))
    args = parser.parse_args()
    if not args.download:
        os.environ['HF_HUB_OFFLINE'] = '1'
    from huggingface_hub import snapshot_download
    from immich_ml.models.semantic_mask import MANIFEST, MODEL_NAME
    from immich_ml.models.semantic_mask_manifest import verify_snapshot
    cache = args.cache_root / 'semantic-mask' / MODEL_NAME / 'hub'
    receipt = []
    for model in MANIFEST:
        path = Path(snapshot_download(model['repository'], revision=model['revision'], cache_dir=cache,
                     allow_patterns=list(model['files']), local_files_only=not args.download))
        verify_snapshot(path, model['files'])
        receipt.append({'repository': model['repository'], 'revision': model['revision'], 'files': model['files']})
    # Only fully verified snapshots produce the receipt. Inference independently repeats verification.
    (cache.parent / 'verified-models.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print('Both pinned semantic snapshots verified; inference does not download missing files')


if __name__ == '__main__':
    main()
