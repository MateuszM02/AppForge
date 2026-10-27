// RepoRadar can call an LLM through OpenRouter; AppForge never does (the calling agent is the LLM), so the OpenAI
// SDK is replaced by this stub. The pipeline only constructs it when OPENROUTER_API_KEY is set and NO_LLM_MODE is off,
// and AppForge always sets NO_LLM_MODE=true.
export default class OpenAI {
  constructor() {
    throw new Error('LLM calls are disabled in AppForge (NO_LLM_MODE).');
  }
}
