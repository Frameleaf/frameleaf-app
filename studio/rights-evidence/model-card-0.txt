---
base_model: facebook/musicgen-small
library_name: transformers.js
license: cc-by-nc-4.0
---

https://huggingface.co/facebook/musicgen-small with ONNX weights to be compatible with Transformers.js.

## Usage (Transformers.js)

If you haven't already, you can install the [Transformers.js](https://huggingface.co/docs/transformers.js) JavaScript library from [NPM](https://www.npmjs.com/package/@huggingface/transformers) using:
```bash
npm install @huggingface/transformers
```

**Example:** Generate music with `Xenova/musicgen-small`.
```js
import { AutoTokenizer, MusicgenForConditionalGeneration, RawAudio } from '@huggingface/transformers';

// Load tokenizer and model
const tokenizer = await AutoTokenizer.from_pretrained('Xenova/musicgen-small');
const model = await MusicgenForConditionalGeneration.from_pretrained('Xenova/musicgen-small', {
  dtype: {
    text_encoder: 'q8',
    decoder_model_merged: 'q8',
    encodec_decode: 'fp32',
  },
});

// Prepare text input
const prompt = 'a light and cheerly EDM track, with syncopated drums, aery pads, and strong emotions bpm: 130';
const inputs = tokenizer(prompt);

// Generate audio
const audio_values = await model.generate({
  ...inputs,
  max_new_tokens: 500,
  do_sample: true,
  guidance_scale: 3,
});

// (Optional) Write the output to a WAV file
const audio = new RawAudio(audio_values.data, model.config.audio_encoder.sampling_rate);
audio.save('musicgen.wav');
```

<audio controls src="https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/cJ9HFIDstOqJN0eGyJwlS.wav"></audio>

We also released an online demo, which you can try yourself: https://huggingface.co/spaces/Xenova/musicgen-web


<video controls src="https://cdn-uploads.huggingface.co/production/uploads/61b253b7ac5ecaae3d1efe0c/zc43B_VuUVJm4kOJPOHNh.mp4"></video>

---

Note: Having a separate repo for ONNX weights is intended to be a temporary solution until WebML gains more traction. If you would like to make your models web-ready, we recommend converting to ONNX using [🤗 Optimum](https://huggingface.co/docs/optimum/index) and structuring your repo like this one (with ONNX weights located in a subfolder named `onnx`).
