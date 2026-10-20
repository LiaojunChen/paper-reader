import test from 'node:test';
import assert from 'node:assert/strict';
import { unescapeMath } from '../shared/text.js';
import { articleLang } from '../client/src/articleLang.js';

test('Turndown escapes are removed inside TeX, not in surrounding text', () => {
  assert.equal(unescapeMath('After each action $a\\_t$, a heuristic $h\\_t$ and \\*not\\* math'),
    'After each action $a_t$, a heuristic $h_t$ and \\*not\\* math');
  assert.equal(unescapeMath('$$\\\\sum\\_{i=1}^n x\\_i$$'), '$$\\sum_{i=1}^n x_i$$');
  assert.equal(unescapeMath('inline \\\\(x\\_1\\\\) and block \\\\[y\\_2\\\\]'), 'inline $x_1$ and block $$y_2$$');
});

test('prices and lone dollar signs are left alone', () => {
  for (const s of ['costs $5 and $10\\_000 later', 'a $ sign and file\\_name', 'from $ 3 to $ 4']) assert.equal(unescapeMath(s), s);
});

test('article language detection', () => {
  assert.equal(articleLang('LLM Powered Autonomous Agents\n\nBuilding agents with LLM as its core controller is a cool concept.'), 'en');
  assert.equal(articleLang('科技爱好者周刊（第 285 期）\n\n这里记录每周值得分享的科技内容，周五发布。'), 'zh-CN');
  assert.equal(articleLang('大規模言語モデルを使ったエージェントについて、ここではその仕組みを説明します。'), 'ja');
  assert.equal(articleLang('대규모 언어 모델 기반 에이전트에 대해 설명합니다.'), 'ko');
  // Code and links don't count toward the language
  assert.equal(articleLang('中文说明文字，下面是示例代码。\n```js\nconst agent = createAgent({ model, tools, memory })\n```'), 'zh-CN');
});
