"""Image build gate: imports and tensor ABI only; no checkpoint, media or network access."""
import os

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
import numpy as np
import torch
import torchvision
import transformers
from transformers import Florence2ForConditionalGeneration, Florence2Processor, Sam2Model, Sam2Processor

assert torch.__version__.split('+')[0] == '2.5.1', torch.__version__
assert torchvision.__version__.split('+')[0] == '0.20.1', torchvision.__version__
assert transformers.__version__ == '5.16.1', transformers.__version__
# Torch/NumPy bridge is used by real mask postprocessing; an import-only gate misses ABI failures.
np.testing.assert_array_equal(torch.from_numpy(np.zeros((2, 2), dtype=np.float32)).numpy(), np.zeros((2, 2)))
if os.environ.get('DEVICE') == 'cpu':
    assert torch.version.cuda is None, 'The standard CPU image must not install CUDA Torch wheels'
print(f'Semantic runtime import/NumPy gate passed: Torch {torch.__version__}, vision {torchvision.__version__}, Transformers {transformers.__version__}')
