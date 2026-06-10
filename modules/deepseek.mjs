// Zen Tab Wand - DeepSeek engine orchestrators.
//
// DeepSeek uses the same prompt/plan shape as the Ollama engine. This module
// adapts the OpenAI-compatible transport to the shared classifier helpers.

import { LOG } from "./config.mjs";
import { getDeepSeekApiKey, getDeepSeekBaseUrl, getDeepSeekModel } from "./rules.mjs";
import { showToast } from "./ui-toast.mjs";
import { classifyExistingGroupsBatch, runPass2OllamaFresh, unifiedClassifyOllama } from "./ollama.mjs";
import {
  checkDeepSeekReady,
  deepseekGenerateJson,
  normalizeDeepSeekBaseUrl,
  reportDeepSeekError,
} from "./deepseek-transport.mjs";

export { checkDeepSeekReady, normalizeDeepSeekBaseUrl, reportDeepSeekError };

const getDeepSeekGenerateJson = (baseUrl, apiKey, model) =>
  (prompt) => deepseekGenerateJson(baseUrl, apiKey, model, prompt);

export const classifyExistingGroupsDeepSeekBatch = async (unmatched, rules, baseUrl, apiKey, model) =>
  classifyExistingGroupsBatch(
    unmatched,
    rules,
    baseUrl,
    model,
    getDeepSeekGenerateJson(baseUrl, apiKey, model),
    "DeepSeek",
  );

export const runPass2DeepSeek = async (unmatched, rules) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!unmatched?.length) return empty;

  const baseUrl = getDeepSeekBaseUrl();
  const apiKey = getDeepSeekApiKey();
  const model = getDeepSeekModel();
  try {
    return await unifiedClassifyOllama(
      unmatched,
      rules,
      baseUrl,
      model,
      getDeepSeekGenerateJson(baseUrl, apiKey, model),
      "DeepSeek",
    );
  } catch (e) {
    console.error(`${LOG} DeepSeek unified classification failed:`, e);
    showToast(`DeepSeek classification failed: ${e.message || e}`);
    return { ...empty, skipped: unmatched, failed: e.message || String(e) };
  }
};

export const runPass2DeepSeekFresh = async (allTabs) => {
  const empty = { assignedToExisting: [], newGroups: [], skipped: [] };
  if (!allTabs?.length) return empty;

  const baseUrl = getDeepSeekBaseUrl();
  const apiKey = getDeepSeekApiKey();
  const model = getDeepSeekModel();
  try {
    return await runPass2OllamaFresh(
      allTabs,
      baseUrl,
      model,
      getDeepSeekGenerateJson(baseUrl, apiKey, model),
      "DeepSeek",
    );
  } catch (e) {
    console.error(`${LOG} DeepSeek fresh classification failed:`, e);
    showToast(`DeepSeek fresh classification failed: ${e.message || e}`);
    return { ...empty, skipped: allTabs, failed: e.message || String(e) };
  }
};
