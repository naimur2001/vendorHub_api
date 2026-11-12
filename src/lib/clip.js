// Free, self-hosted visual search model: CLIP (OpenAI, MIT license) run by Transformers.js.
// Pictures and texts get a 512-number "fingerprint" in the same space, so a photo can be compared
// with product photos AND product titles. The model is downloaded once into CLIP_CACHE_DIR,
// then everything runs on this server: no API key, no cost, photos never leave the machine.
import path from 'node:path';
import {
  env as hf,
  AutoProcessor,
  AutoTokenizer,
  CLIPVisionModelWithProjection,
  CLIPTextModelWithProjection,
  RawImage,
} from '@huggingface/transformers';
import { env } from '../config/env.js';

const MODEL = 'Xenova/clip-vit-base-patch32';
hf.cacheDir = path.resolve(env.CLIP_CACHE_DIR);

// Loaded once, on first use (about a few hundred MB of memory); a failed load can be retried.
let loading = null;
function load() {
  loading ??= Promise.all([
    AutoProcessor.from_pretrained(MODEL),
    CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' }),
    AutoTokenizer.from_pretrained(MODEL),
    CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' }),
  ])
    .then(([processor, vision, tokenizer, text]) => ({ processor, vision, tokenizer, text }))
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** The fingerprint of one picture (normalized, 512 numbers). */
export async function embedImage(buffer) {
  const m = await load();
  const image = await RawImage.fromBlob(new Blob([buffer]));
  const inputs = await m.processor(image);
  const { image_embeds } = await m.vision(inputs);
  return Array.from(image_embeds.normalize(2, -1).data);
}

/** The fingerprints of several texts (for example product titles). */
export async function embedTexts(texts) {
  const m = await load();
  const inputs = m.tokenizer(texts, { padding: true, truncation: true });
  const { text_embeds } = await m.text(inputs);
  const all = text_embeds.normalize(2, -1);
  const dim = all.dims[1];
  return texts.map((_, i) => Array.from(all.data.slice(i * dim, (i + 1) * dim)));
}

/** pgvector's text form: "[0.1,0.2,...]" (passed as a query PARAMETER, never glued into SQL). */
export const toVectorLiteral = (v) => `[${v.map((n) => Number(n).toFixed(6)).join(',')}]`;