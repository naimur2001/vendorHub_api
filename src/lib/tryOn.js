import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { AppError } from './errors.js';

let client = null;

// Creates ONE picture: the person wearing the garment, from one view.
// Nothing is stored: the images live only in memory during the call.
// mock mode: no AI and no cost; it returns the person photo unchanged (for development and tests).
export async function runTryOn({ person, garment, reference, prompt }) {
  if (env.TRYON_MODE === 'mock') {
    return { mimeType: person.mimeType, data: person.buffer.toString('base64') };
  }
  if (!env.GEMINI_API_KEY) throw new AppError(503, 'Virtual try-on is not configured');
  client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  const asPart = (img) => ({ inlineData: { mimeType: img.mimeType, data: img.buffer.toString('base64') } });
  const parts = [{ text: prompt }, asPart(person), asPart(garment), ...(reference ? [asPart(reference)] : [])];

  let response;
  try {
    response = await client.models.generateContent({
      model: env.GEMINI_IMAGE_MODEL,
      contents: [{ role: 'user', parts }],
    });
  } catch (err) {
    logger.warn({ status: err.status, message: err.message }, 'try-on AI call failed'); // never log the images
    if (err.status === 429) throw new AppError(429, 'The free AI quota is used up for now. Please try again later.');
    throw new AppError(502, 'The AI service could not create the picture. Please try again.');
  }

  const image = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!image) throw new AppError(422, 'The AI could not dress this photo. Try a clear, full-body photo.');
  return { mimeType: image.mimeType ?? 'image/png', data: image.data };
}