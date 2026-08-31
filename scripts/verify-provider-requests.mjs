import assert from 'node:assert/strict';
import {
  buildGeminiPayload,
  buildGoogleGenerateRequest,
  buildNovelAiRequest,
  coerceApiFormat,
} from '../src/utils/providerRequests.mjs';

const baseConfig = {
  apiKey: 'test-key',
  model: 'gemini-test',
  includeImageConfig: true,
  imageConfig: { imageSize: '2K', aspectRatio: '16:9' },
  includeThoughts: true,
  thinkingBudget: 256,
  includeSafetySettings: true,
  safety: {
    HARM_CATEGORY_HARASSMENT: 'BLOCK_NONE',
    HARM_CATEGORY_HATE_SPEECH: 'OFF',
  },
  useResponseModalities: true,
  customJson: '',
};

const gemini = await buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'gemini',
  apiUrl: 'https://generativelanguage.googleapis.com',
  apiVersion: 'v1beta',
});
assert.equal(
  gemini.url,
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=test-key',
);
assert.equal(gemini.headers.Authorization, undefined);

const vertex = await buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'vertex',
  apiUrl: 'https://aiplatform.googleapis.com',
  apiVersion: 'v1beta1',
  vertexAuthMode: 'json',
  vertexProjectId: 'project-a',
  vertexDefaultLocation: 'us-central1',
  vertexPublisher: 'google',
  vertexAccessToken: 'ya29.token',
});
assert.equal(
  vertex.url,
  'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/project-a/locations/us-central1/publishers/google/models/gemini-test:generateContent',
);
assert.equal(vertex.headers.Authorization, 'Bearer ya29.token');

const vertexApiKey = await buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'vertex',
  apiUrl: 'https://aiplatform.googleapis.com',
  vertexAuthMode: 'apiKey',
  vertexDefaultLocation: 'asia-northeast1',
  vertexPublisher: 'google',
});
assert.equal(
  vertexApiKey.url,
  'https://asia-northeast1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-test:generateContent?key=test-key',
);
assert.equal(vertexApiKey.headers.Authorization, undefined);

const vertexModelLocation = await buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'vertex',
  apiUrl: 'https://aiplatform.googleapis.com',
  vertexAuthMode: 'apiKey',
  vertexDefaultLocation: 'us-central1',
  vertexModelLocations: [{ model: 'gemini-test', location: 'europe-west4' }],
  vertexPublisher: 'google',
});
assert.equal(
  vertexModelLocation.url,
  'https://europe-west4-aiplatform.googleapis.com/v1/publishers/google/models/gemini-test:generateContent?key=test-key',
);

const vertexDefaultLocation = await buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'vertex',
  apiUrl: 'https://aiplatform.googleapis.com',
  vertexAuthMode: 'apiKey',
  vertexPublisher: 'google',
});
assert.equal(
  vertexDefaultLocation.url,
  'https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-test:generateContent?key=test-key',
);

const vertexGlobalLocation = await buildGoogleGenerateRequest({
  ...baseConfig,
  apiFormat: 'vertex',
  apiUrl: 'https://aiplatform.googleapis.com',
  vertexAuthMode: 'json',
  vertexProjectId: 'project-a',
  vertexDefaultLocation: 'global',
  vertexPublisher: 'google',
  vertexAccessToken: 'ya29.token',
});
assert.equal(
  vertexGlobalLocation.url,
  'https://aiplatform.googleapis.com/v1beta1/projects/project-a/locations/global/publishers/google/models/gemini-test:generateContent',
);

assert.equal(coerceApiFormat('vertex-express'), 'vertex');

const payload = buildGeminiPayload([{ role: 'user', parts: [{ text: 'draw' }] }], baseConfig);
assert.deepEqual(payload.generationConfig.imageConfig, {
  imageSize: '2K',
  aspectRatio: '16:9',
});
assert.deepEqual(payload.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
assert.deepEqual(payload.generationConfig.thinkingConfig, {
  thinkingBudget: 256,
  includeThoughts: true,
});
assert.deepEqual(payload.safetySettings, [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
]);

const novelai = buildNovelAiRequest(
  {
    apiUrl: 'https://image.novelai.net',
    apiKey: 'nai-key',
    model: 'nai-diffusion-4-full',
    novelAiConfig: {
      width: 1000,
      height: 1400,
      aspectRatio: '5:7',
      lockAspectRatio: true,
      steps: 24,
      scale: 6,
      sampler: 'k_dpmpp_2m',
      seed: 123456789,
      ucPreset: 1,
      uc: 'lowres',
      qualityToggle: false,
      dynamicThresholding: true,
      sm: true,
      smDyn: false,
      cfgRescale: 0.2,
      noiseSchedule: 'karras',
    },
    customJson: '{"parameters":{"steps":12},"action":"generate"}',
  },
  { prompt: 'cat cafe\n负面提示词：bad hands' },
);
assert.equal(novelai.url, 'https://image.novelai.net/ai/generate-image');
assert.equal(novelai.headers.Authorization, 'Bearer nai-key');
assert.equal(novelai.payload.input, 'cat cafe');
assert.equal(novelai.payload.model, 'nai-diffusion-4-full');
assert.equal(novelai.payload.parameters.steps, 12);
assert.equal(novelai.payload.parameters.scale, 6);
assert.equal(novelai.payload.parameters.sampler, 'k_dpmpp_2m');
assert.equal(novelai.payload.parameters.n_samples, 1);
assert.equal(novelai.payload.parameters.ucPreset, 1);
assert.equal(novelai.payload.parameters.uc, 'lowres, bad hands');
assert.equal(novelai.payload.parameters.qualityToggle, false);
assert.equal(novelai.payload.parameters.dynamic_thresholding, true);
assert.equal(novelai.payload.parameters.sm, true);
assert.equal(novelai.payload.parameters.sm_dyn, false);
assert.equal(novelai.payload.parameters.cfg_rescale, 0.2);
assert.equal(novelai.payload.parameters.noise_schedule, 'karras');
assert.equal(novelai.payload.parameters.seed, 123456789);
assert.equal(novelai.payload.parameters.width, 1000);
assert.equal(novelai.payload.parameters.height, 1400);
assert.equal('aspectRatio' in novelai.payload.parameters, false);

const mergedNovelAi = buildNovelAiRequest(
  {
    apiUrl: 'https://image.novelai.net',
    apiKey: 'nai-key',
    model: 'nai-diffusion-4-full',
    novelAiConfig: {
      width: 832,
      height: 1216,
      steps: 32,
      scale: 7,
      sampler: 'k_euler',
      seed: 987654321,
      ucPreset: 2,
      uc: 'system bad, task bad',
      qualityToggle: true,
      dynamicThresholding: false,
      sm: false,
      smDyn: true,
      cfgRescale: 0.35,
      noiseSchedule: 'native',
    },
    customJson: '{"parameters":{"width":960,"cfg_rescale":0.5}}',
  },
  { prompt: 'city skyline\nNegative Prompt: inline bad' },
);
assert.equal(mergedNovelAi.payload.input, 'city skyline');
assert.equal(mergedNovelAi.payload.parameters.width, 960);
assert.equal(mergedNovelAi.payload.parameters.height, 1216);
assert.equal(mergedNovelAi.payload.parameters.steps, 32);
assert.equal(mergedNovelAi.payload.parameters.scale, 7);
assert.equal(mergedNovelAi.payload.parameters.seed, 987654321);
assert.equal(mergedNovelAi.payload.parameters.uc, 'system bad, task bad, inline bad');
assert.equal(mergedNovelAi.payload.parameters.cfg_rescale, 0.5);
assert.equal(mergedNovelAi.payload.parameters.n_samples, 1);

console.log('provider request checks passed');
