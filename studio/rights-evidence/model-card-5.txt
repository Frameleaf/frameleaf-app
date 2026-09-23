---
license: other
license_name: lfm1.0
license_link: LICENSE
language:
- en
- ja
- ko
- fr
- es
- de
- it
- pt
- ar
- zh
pipeline_tag: image-text-to-text
tags:
- liquid
- edge
- lfm2.5-vl
- lfm2.5
- onnx
- onnxruntime
- webgpu
base_model:
- LiquidAI/LFM2.5-VL-450M
---

<div align="center">
  <img
    src="https://cdn-uploads.huggingface.co/production/uploads/61b8e2ba285851687028d395/2b08LKpev0DNEk6DlnWkY.png"
    alt="Liquid AI"
    style="width: 100%; max-width: 100%; height: auto; display: inline-block; margin-bottom: 0.5em; margin-top: 0.5em;"
  />
  <div style="display: flex; justify-content: center; gap: 0.5em; margin-bottom: 1em;">
    <a href="https://playground.liquid.ai/chat?model=lfm2.5-vl-450m"><strong>Try LFM</strong></a> •
    <a href="https://docs.liquid.ai/lfm"><strong>Documentation</strong></a> •
    <a href="https://leap.liquid.ai/"><strong>LEAP</strong></a> •
    <a href="https://discord.com/invite/liquid-ai"><strong>Discord</strong></a>
  </div>
</div>

# LFM2.5-VL-450M-ONNX

ONNX export of [LFM2.5-VL-450M](https://huggingface.co/LiquidAI/LFM2.5-VL-450M) for cross-platform inference.

## Recommended Variants

| Encoder | Decoder | Size | Platform | Use Case |
|---------|---------|------|----------|----------|
| FP16 | Q4 | ~770MB | WebGPU, Server | Recommended for most uses |
| FP16 | FP16 | ~1.0GB | Server | Higher quality |

- **WebGPU**: Use FP16 encoder + Q4 decoder (Q8 not supported on WebGPU)
- **Server**: FP16+Q4 for efficiency, FP16+FP16 for quality

## Model Files

```
onnx/
├── embed_tokens.onnx               # Token embeddings (FP32, 256MB)
├── embed_tokens_fp16.onnx          # Token embeddings (FP16, 128MB)
├── embed_tokens_fp16.onnx_data
├── vision_encoder.onnx             # Vision encoder (FP32, 359MB)
├── vision_encoder.onnx_data
├── vision_encoder_fp16.onnx        # Vision encoder (FP16, 180MB)
├── vision_encoder_fp16.onnx_data
├── vision_encoder_q4.onnx          # Vision encoder (Q4, 57MB)
├── vision_encoder_q4.onnx_data
├── vision_encoder_q8.onnx          # Vision encoder (Q8, 105MB)
├── vision_encoder_q8.onnx_data
├── decoder_model_merged.onnx       # Language decoder (FP32, 1.4GB)
├── decoder_model_merged.onnx_data
├── decoder_model_merged_fp16.onnx  # Language decoder (FP16, 692MB)
├── decoder_model_merged_fp16.onnx_data
├── decoder_model_merged_q4.onnx    # Language decoder (Q4, 459MB)
├── decoder_model_merged_q4.onnx_data
├── decoder_model_merged_q8.onnx    # Language decoder (Q8, 604MB)
└── decoder_model_merged_q8.onnx_data
```

## Python

### Installation

```bash
pip install onnxruntime transformers pillow torch huggingface_hub
# or with GPU support:
pip install onnxruntime-gpu transformers pillow torch huggingface_hub
```

### Inference

```python
import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from transformers import AutoProcessor
from PIL import Image

# Download model files (fp16 encoder + q4 decoder recommended)
model_id = "LiquidAI/LFM2.5-VL-450M-ONNX"
embed_tokens_path = hf_hub_download(model_id, "onnx/embed_tokens_fp16.onnx")
vision_encoder_path = hf_hub_download(model_id, "onnx/vision_encoder_fp16.onnx")
decoder_path = hf_hub_download(model_id, "onnx/decoder_model_merged_q4.onnx")

# Download all data files
from huggingface_hub import list_repo_files
for f in list_repo_files(model_id):
    if any(f.startswith(f"onnx/{name}") for name in [
        "embed_tokens_fp16.onnx_data",
        "vision_encoder_fp16.onnx_data",
        "decoder_model_merged_q4.onnx_data"
    ]):
        hf_hub_download(model_id, f)

# Load ONNX sessions
embed_tokens = ort.InferenceSession(embed_tokens_path)
vision_encoder = ort.InferenceSession(vision_encoder_path)
decoder = ort.InferenceSession(decoder_path)

# Load processor
processor = AutoProcessor.from_pretrained("LiquidAI/LFM2.5-VL-450M", trust_remote_code=True)

# Prepare input
image = Image.open("photo.jpg")
messages = [{"role": "user", "content": [
    {"type": "image"},
    {"type": "text", "text": "What is in this image?"}
]}]

# Process inputs
prompt = processor.apply_chat_template(messages, add_generation_prompt=True)
inputs = processor(images=[image], text=prompt, return_tensors="pt")

# Convert to numpy with correct dtypes
pixel_values = inputs["pixel_values"].numpy().astype(np.float32)
pixel_attention_mask = inputs["pixel_attention_mask"].numpy().astype(np.int64)
spatial_shapes = inputs["spatial_shapes"].numpy().astype(np.int64)
input_ids = inputs["input_ids"].numpy().astype(np.int64)

# Get image embeddings
image_outputs = vision_encoder.run(None, {
    "pixel_values": pixel_values,
    "pixel_attention_mask": pixel_attention_mask,
    "spatial_shapes": spatial_shapes,
})
image_embeds = image_outputs[0]

# Get token embeddings
token_outputs = embed_tokens.run(None, {"input_ids": input_ids})
token_embeds = token_outputs[0]

# Replace <image> tokens with image embeddings
image_token_id = processor.tokenizer.convert_tokens_to_ids("<image>")
image_positions = np.where(input_ids[0] == image_token_id)[0]
for i, pos in enumerate(image_positions):
    if i < len(image_embeds):
        token_embeds[0, pos] = image_embeds[i]

# Initialize KV cache for stateful decoding
ONNX_DTYPE = {"tensor(float)": np.float32, "tensor(float16)": np.float16, "tensor(int64)": np.int64}
cache = {}
for inp in decoder.get_inputs():
    if inp.name in {"inputs_embeds", "attention_mask", "position_ids"}:
        continue
    shape = [d if isinstance(d, int) else 1 for d in inp.shape]
    for i, d in enumerate(inp.shape):
        if isinstance(d, str) and "sequence" in d.lower():
            shape[i] = 0
    cache[inp.name] = np.zeros(shape, dtype=ONNX_DTYPE.get(inp.type, np.float32))

# Generate tokens
seq_len = token_embeds.shape[1]
generated_tokens = []

for step in range(100):  # max tokens
    if step == 0:
        embeds = token_embeds.astype(np.float32)
    else:
        last_token = np.array([[generated_tokens[-1]]], dtype=np.int64)
        embeds = embed_tokens.run(None, {"input_ids": last_token})[0].astype(np.float32)

    attn_mask = np.ones((1, seq_len + len(generated_tokens)), dtype=np.int64)
    feed = {"inputs_embeds": embeds, "attention_mask": attn_mask, **cache}

    outputs = decoder.run(None, feed)
    next_token = int(np.argmax(outputs[0][0, -1]))
    generated_tokens.append(next_token)

    # Update cache
    for i, out in enumerate(decoder.get_outputs()[1:], 1):
        name = out.name.replace("present_conv", "past_conv").replace("present.", "past_key_values.")
        if name in cache:
            cache[name] = outputs[i]

    if next_token == processor.tokenizer.eos_token_id:
        break

print(processor.tokenizer.decode(generated_tokens, skip_special_tokens=True))
```

## WebGPU (Browser)

### Installation

```bash
npm install onnxruntime-web @huggingface/transformers
```

### Enable WebGPU

WebGPU is required for browser inference. To enable:

1. **Chrome/Edge**: Navigate to `chrome://flags/#enable-unsafe-webgpu`, enable, and restart
2. **Verify**: Check `chrome://gpu` for "WebGPU" status
3. **Test**: Run `navigator.gpu.requestAdapter()` in DevTools console

### Inference

```javascript
import * as ort from "onnxruntime-web/webgpu";
import { AutoTokenizer } from "@huggingface/transformers";

// Check WebGPU availability
if (!navigator.gpu) {
  throw new Error("WebGPU not available. Enable at chrome://flags/#enable-unsafe-webgpu");
}
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("WebGPU adapter not found. Check chrome://gpu for status.");
}

ort.env.wasm.numThreads = 1;

const modelId = "LiquidAI/LFM2.5-VL-450M-ONNX";
const modelBase = `https://huggingface.co/${modelId}/resolve/main`;

// Load tokenizer
const tokenizer = await AutoTokenizer.from_pretrained(modelId);

// Load ONNX sessions with external data
async function loadSession(name) {
  const onnxPath = `${modelBase}/onnx/${name}.onnx`;
  const fileName = `${name}.onnx_data`;
  return ort.InferenceSession.create(onnxPath, {
    executionProviders: ["webgpu"],
    externalData: [{ path: fileName, data: `${modelBase}/onnx/${fileName}` }],
  });
}

const embedTokens = await loadSession("embed_tokens_fp16");
const visionEncoder = await loadSession("vision_encoder_fp16");
const decoder = await loadSession("decoder_model_merged_q4");

// Model config
const hiddenSize = 1024;
const numKVHeads = 8;
const headDim = 64;

// Get text embeddings helper
async function getTextEmbeddings(ids) {
  const tensor = new ort.Tensor("int64", new BigInt64Array(ids.map(BigInt)), [1, ids.length]);
  const out = await embedTokens.run({ input_ids: tensor });
  return out.inputs_embeds;
}

// Initialize KV cache
function initCache() {
  const cache = {};
  for (const name of decoder.inputNames) {
    if (name.startsWith("past_conv")) {
      cache[name] = new ort.Tensor("float32", new Float32Array(hiddenSize * 3), [1, hiddenSize, 3]);
    } else if (name.startsWith("past_key_values")) {
      cache[name] = new ort.Tensor("float32", new Float32Array(0), [1, numKVHeads, 0, headDim]);
    }
  }
  return cache;
}

// Update cache from outputs
function updateCache(cache, outputs) {
  for (const [name, tensor] of Object.entries(outputs)) {
    if (name.startsWith("present_conv")) {
      cache[name.replace("present_conv", "past_conv")] = tensor;
    } else if (name.startsWith("present.")) {
      cache[name.replace("present.", "past_key_values.")] = tensor;
    }
  }
}

// Build prompt and tokenize
const prompt = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, tokenize: false });
const inputIds = tokenizer.encode(prompt);

// Get embeddings (for VL: merge image embeddings at <image> token positions)
let inputsEmbeds = await getTextEmbeddings(inputIds);

// Generation loop
const cache = initCache();
const eosTokenId = tokenizer.eos_token_id;
const generatedTokens = [];
let curLen = inputsEmbeds.dims[1];
let embeds = inputsEmbeds;

for (let step = 0; step < 256; step++) {
  const attentionMask = new ort.Tensor("int64", new BigInt64Array(curLen).fill(1n), [1, curLen]);

  const outputs = await decoder.run({ inputs_embeds: embeds, attention_mask: attentionMask, ...cache });

  // Greedy decode: argmax of last token logits
  const logits = outputs.logits;
  const vocabSize = logits.dims[2];
  const lastLogits = logits.data.slice((logits.dims[1] - 1) * vocabSize);
  const nextToken = lastLogits.indexOf(Math.max(...lastLogits));

  generatedTokens.push(nextToken);
  if (nextToken === eosTokenId) break;

  updateCache(cache, outputs);
  embeds = await getTextEmbeddings([nextToken]);
  curLen++;
}

console.log(tokenizer.decode(generatedTokens, { skip_special_tokens: true }));
```

### WebGPU Notes

- Recommended: `vision_encoder_fp16.onnx` + `decoder_model_merged_q4.onnx`
- For higher quality: `vision_encoder_fp16.onnx` + `decoder_model_merged_fp16.onnx`
- Image preprocessing requires tiling (512x512), patch extraction (16x16), and normalization
- int64 tensors require `BigInt64Array`

## transformers.js

This model is compatible with [transformers.js](https://huggingface.co/docs/transformers.js) v4.0+ for browser-based inference with WebGPU:

```javascript
import { AutoModelForImageTextToText, AutoProcessor, RawImage } from "@huggingface/transformers";

const model = await AutoModelForImageTextToText.from_pretrained(
  "LiquidAI/LFM2.5-VL-450M-ONNX",
  {
    device: "webgpu",
    dtype: {
      vision_encoder: "fp16",
      embed_tokens: "fp16",
      decoder_model_merged: "q4",
    },
  }
);

const processor = await AutoProcessor.from_pretrained("LiquidAI/LFM2.5-VL-450M-ONNX");

const image = await RawImage.fromURL("https://example.com/photo.jpg");
const messages = [
  { role: "user", content: [{ type: "image" }, { type: "text", text: "What is in this image?" }] },
];

const chatPrompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
const inputs = await processor(image, chatPrompt, { add_special_tokens: false });

const outputs = await model.generate({
  ...inputs,
  do_sample: false,
  max_new_tokens: 128,
});

const inputLength = inputs.input_ids.dims.at(-1);
const generated = outputs.slice(null, [inputLength, null]);
console.log(processor.batch_decode(generated, { skip_special_tokens: true })[0]);
```

See our [WebGPU demo](https://huggingface.co/spaces/LiquidAI/LFM2.5-VL-450M-WebGPU) for a full real-time video captioning and object detection application.

## License

This model is released under the [LFM 1.0 License](LICENSE).

