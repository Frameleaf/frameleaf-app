"""Offline annotated-fixture gate; run only on an explicit qualification host with installed weights."""
import argparse
import base64
import io
import json
import os
import resource
import socket
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path)
    parser.add_argument('--subject-truth', type=Path, required=True)
    parser.add_argument('--sky-truth', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--device', choices=['cpu', 'cuda'], default='cpu')
    parser.add_argument('--minimum-iou', type=float, default=0.75)
    parser.add_argument('--maximum-seconds', type=float, default=120)
    args = parser.parse_args()
    assert 0 < args.minimum_iou <= 1 and 0 < args.maximum_seconds <= 120
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    def no_network(*_args, **_kwargs):
        raise RuntimeError('Network access attempted during offline qualification')
    socket.socket.connect = no_network
    socket.create_connection = no_network
    from PIL import Image
    import numpy as np
    from immich_ml.models.semantic_mask import SemanticMaskModel, MODEL_NAME
    model = SemanticMaskModel(MODEL_NAME, device=args.device)
    image = Image.open(args.image).convert('RGB')
    assert max(image.size) <= 2048
    args.output.mkdir(parents=True, exist_ok=True)
    evidence = []
    for target, truth_path in [('subject', args.subject_truth), ('sky', args.sky_truth)]:
        start = time.monotonic()
        result = model.predict(image, target=target)
        elapsed = time.monotonic() - start
        png = base64.b64decode(result['png'], validate=True)
        mask = Image.open(io.BytesIO(png)).convert('L')
        truth = Image.open(truth_path).convert('L')
        assert mask.size == truth.size == image.size and result['coordinates'] == 'sensor-active'
        predicted, expected = np.array(mask) > 127, np.array(truth) > 127
        assert predicted.any() and expected.any()
        iou = float(np.logical_and(predicted, expected).sum() / np.logical_or(predicted, expected).sum())
        (args.output / f'{target}.png').write_bytes(png)
        evidence.append({'target': target, 'seconds': elapsed, 'iou': iou, 'models': result['models']})
        assert elapsed <= args.maximum_seconds, 'Proposal exceeded the server deadline'
        assert iou >= args.minimum_iou, 'Mask quality failed the annotated fixture oracle'
    (args.output / 'qualification.json').write_text(json.dumps({'device': args.device, 'image': str(args.image),
        'peakRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'results': evidence}, indent=2) + '\n')
    print('Offline semantic fixture gate passed: verified weights, no network, coordinates, IoU and deadline')


if __name__ == '__main__':
    main()
