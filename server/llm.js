// Minimal LLM client: OpenAI-compatible chat completions (OpenAI/DeepSeek/Qwen/Ollama/...) or Anthropic Messages.
// Both streamed; onDelta receives text chunks.
import { getSettings } from './db.js';

export async function chat({ system, messages, onDelta, maxTokens = 4096, signal }) {
  const s = getSettings();
  if (!s.llmApiKey && !/localhost|127\.0\.0\.1/.test(s.llmBaseUrl)) throw new Error('未配置 LLM API Key，请在「设置」中填写');
  const base = (s.llmBaseUrl || '').replace(/\/+$/, '');
  let full = '';
  const emit = t => { if (t) { full += t; onDelta?.(t); } };

  if (s.llmProvider === 'anthropic') {
    const r = await fetch(`${base || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': s.llmApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.llmModel, max_tokens: maxTokens, system, messages, stream: true }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
    await readSSE(r, ev => {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit(ev.delta.text);
      if (ev.type === 'error') throw new Error(ev.error?.message || 'LLM error');
    });
  } else {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.llmApiKey}` },
      body: JSON.stringify({
        model: s.llmModel, stream: true, max_tokens: maxTokens,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 300)}`);
    await readSSE(r, ev => emit(ev.choices?.[0]?.delta?.content));
  }
  return full;
}

async function readSSE(res, onEvent) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      onEvent(ev);
    }
  }
}
