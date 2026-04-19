/* ============================================
   Claude Verifier - Test Engine
   ============================================ */

// ---- State ----
const state = {
  results: {},  // testId -> { status, score, details }
  running: false,
  chatMessages: [],  // { role, content }
  chatThinking: true,
  chatRawMode: false,
  chatStreaming: false,
};

// ---- Config ----
function getConfig() {
  return {
    endpoint: document.getElementById('apiEndpoint').value.replace(/\/+$/, ''),
    apiKey: document.getElementById('apiKey').value.trim(),
    model: document.getElementById('modelName').value.trim(),
    format: document.getElementById('apiFormat').value,
  };
}

function saveConfig() {
  const config = getConfig();
  const profiles = JSON.parse(localStorage.getItem('claude_verifier_profiles') || '{}');
  const name = prompt('配置名称:', config.model || 'default');
  if (!name) return;
  profiles[name] = config;
  localStorage.setItem('claude_verifier_profiles', JSON.stringify(profiles));
  loadProfileList();
  document.getElementById('profileSelect').value = name;
  showToast('配置已保存: ' + name);
}

function loadProfileList() {
  const profiles = JSON.parse(localStorage.getItem('claude_verifier_profiles') || '{}');
  const select = document.getElementById('profileSelect');
  // Keep the first option
  select.innerHTML = '<option value="">-- 新建配置 --</option>';
  for (const name of Object.keys(profiles)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
}

function loadProfile() {
  const select = document.getElementById('profileSelect');
  const name = select.value;
  if (!name) return;
  const profiles = JSON.parse(localStorage.getItem('claude_verifier_profiles') || '{}');
  const config = profiles[name];
  if (!config) return;
  if (config.endpoint) document.getElementById('apiEndpoint').value = config.endpoint;
  if (config.apiKey) document.getElementById('apiKey').value = config.apiKey;
  if (config.model) document.getElementById('modelName').value = config.model;
  if (config.format) document.getElementById('apiFormat').value = config.format;
  showToast('已加载配置: ' + name);
}

function deleteProfile() {
  const select = document.getElementById('profileSelect');
  const name = select.value;
  if (!name) { showToast('请先选择要删除的配置'); return; }
  if (!confirm(`确定删除配置「${name}」？`)) return;
  const profiles = JSON.parse(localStorage.getItem('claude_verifier_profiles') || '{}');
  delete profiles[name];
  localStorage.setItem('claude_verifier_profiles', JSON.stringify(profiles));
  loadProfileList();
  showToast('已删除配置: ' + name);
}

function loadConfig() {
  // Legacy single-config migration
  const saved = localStorage.getItem('claude_verifier_config');
  if (saved) {
    try {
      const config = JSON.parse(saved);
      if (config.endpoint) document.getElementById('apiEndpoint').value = config.endpoint;
      if (config.apiKey) document.getElementById('apiKey').value = config.apiKey;
      if (config.model) document.getElementById('modelName').value = config.model;
      if (config.format) document.getElementById('apiFormat').value = config.format;
    } catch (e) { /* ignore */ }
  }
  loadProfileList();
}

function toggleConfig() {
  const body = document.getElementById('configBody');
  const toggle = document.getElementById('configToggle');
  body.classList.toggle('collapsed');
  toggle.classList.toggle('collapsed');
}

function toggleKeyVisibility() {
  const input = document.getElementById('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
}

// ---- Fetch Models ----
async function fetchModels() {
  const config = getConfig();
  if (!config.apiKey) { showToast('请先填写 API Key'); return; }

  const btn = document.querySelector('.btn-fetch-models');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    const headers = { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' };
    const res = await fetch(`${config.endpoint}/v1/models`, { headers });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    const data = await res.json();

    const models = (data.data || []).map(m => m.id);
    if (!models.length) { showToast('未获取到模型列表'); return; }

    // Find closest match to "opus-4-6"
    const score = (id) => {
      const lower = id.toLowerCase();
      if (lower.includes('opus-4-7')) return 110;
      if (lower.includes('opus-4-6')) return 100;
      if (lower.includes('opus')) return 50;
      if (lower.includes('claude')) return 10;
      return 0;
    };
    models.sort((a, b) => score(b) - score(a));
    const best = models[0];

    document.getElementById('modelName').value = best;
    showToast(`已选择模型: ${best}`);
  } catch (e) {
    showToast('拉取模型失败: ' + e.message);
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// ---- API Client ----
async function callAPI(messages, { system, streaming = true, thinking = true, onText, onThinking } = {}) {
  const config = getConfig();
  if (!config.apiKey) throw new Error('请先填写 API Key');

  if (config.format === 'anthropic') {
    return callAnthropicAPI(config, messages, { system, streaming, thinking, onText, onThinking });
  } else {
    return callOpenAIAPI(config, messages, { system, streaming, thinking });
  }
}

async function callAnthropicAPI(config, messages, { system, streaming, thinking, onText, onThinking }) {
  const body = {
    model: config.model,
    max_tokens: 128000, // Claude Opus 4.6 exclusive
    messages,
  };

  if (system) body.system = system;

  // Claude 4.6: adaptive thinking + max effort
  if (thinking) {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: 'high' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
    'anthropic-version': '2023-06-01',
  };

  if (thinking) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
  }

  if (streaming) {
    headers['Accept'] = 'text/event-stream';
    body.stream = true;

    const response = await fetch(`${config.endpoint}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API Error ${response.status}: ${err}`);
    }

    return parseAnthropicStream(response, { onText, onThinking });
  }

  const response = await fetch(`${config.endpoint}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API Error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return extractAnthropicResponse(data);
}

async function parseAnthropicStream(response, { onThinking, onText } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let thinkingText = '';
  let responseText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'thinking_delta') {
            thinkingText += event.delta.thinking || '';
            if (onThinking) onThinking(thinkingText);
          } else if (event.delta?.type === 'text_delta') {
            responseText += event.delta.text || '';
            if (onText) onText(responseText);
          }
        }
      } catch (e) { /* skip unparseable lines */ }
    }
  }

  return { text: responseText, thinking: thinkingText };
}

function extractAnthropicResponse(data) {
  let text = '';
  let thinking = '';

  for (const block of (data.content || [])) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'thinking') thinking += block.thinking;
  }

  return { text, thinking };
}

async function callOpenAIAPI(config, messages, { system, streaming, thinking }) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push(...messages);

  const body = {
    model: config.model,
    messages: msgs,
    max_tokens: 4096,
  };

  if (streaming) {
    body.stream = true;

    const response = await fetch(`${config.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API Error ${response.status}: ${err}`);
    }

    return parseOpenAIStream(response);
  }

  const response = await fetch(`${config.endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API Error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content || '',
    thinking: choice?.message?.reasoning_content || choice?.message?.reasoning || '',
  };
}

async function parseOpenAIStream(response, { onText } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);
        const delta = event.choices?.[0]?.delta;
        if (delta?.content) {
          responseText += delta.content;
          if (onText) onText(responseText);
        }
      } catch (e) { /* skip */ }
    }
  }

  return { text: responseText, thinking: '' };
}

// ---- Connection Test ----
async function testConnection() {
  const statusEl = document.getElementById('connectionStatus');
  statusEl.classList.remove('hidden', 'success', 'error');
  statusEl.textContent = '正在测试连接...';
  statusEl.className = 'connection-status';

  try {
    const result = await callAPI(
      [{ role: 'user', content: 'Say "ok" and nothing else.' }],
      { thinking: false }
    );
    statusEl.classList.add('success');
    statusEl.textContent = `连接成功! 模型回复: "${result.text.slice(0, 100)}"`;
  } catch (e) {
    statusEl.classList.add('error');
    statusEl.textContent = `连接失败: ${e.message}`;
  }
}

// ---- Streaming Helper ----
function streamTo(testId) {
  const resultEl = document.getElementById(`test${testId}Result`);
  const responseEl = document.getElementById(`test${testId}Response`);
  const thinkingEl = document.getElementById(`test${testId}Thinking`);
  resultEl.classList.remove('hidden');
  if (responseEl) responseEl.textContent = '';
  if (thinkingEl) { thinkingEl.style.display = 'none'; thinkingEl.textContent = ''; }
  const timing = { start: performance.now(), ttft: null };
  return {
    onText(text) {
      if (timing.ttft === null) timing.ttft = performance.now();
      if (responseEl) responseEl.textContent = text;
    },
    onThinking(thinking) {
      if (timing.ttft === null) timing.ttft = performance.now();
      if (thinkingEl) { thinkingEl.style.display = ''; thinkingEl.textContent = thinking; }
    },
    timing,
  };
}

function calcTiming(stream) {
  const now = performance.now();
  const total = now - stream.timing.start;
  const ttft = stream.timing.ttft ? stream.timing.ttft - stream.timing.start : null;
  const generation = ttft !== null ? now - stream.timing.ttft : null;
  return { total, ttft, generation };
}

// ---- Test Definitions ----
const tests = {
  // Test 1: Chinese Quotes
  1: {
    name: '中文引号检测',
    async run() {
      const stream = streamTo(1);
      const result = await callAPI([{
        role: 'user',
        content: '请在下面的句子中使用中文引号（即\u201c\u201d这种引号）：他说____你好____。请直接输出完整句子，不要解释。',
      }], stream);

      const text = result.text;
      const hasChinaQuote = /[\u201c\u201d\u300c\u300d\u300e\u300f]/.test(text);
      const hasFullWidthQuote = text.includes('\u201c') || text.includes('\u201d');
      const hasQuotes = hasChinaQuote || hasFullWidthQuote;

      let status, analysis, score;
      if (hasQuotes) {
        // 4.7 can output Chinese quotes; older versions cannot
        status = 'pass';
        score = 80;
        analysis = {
          type: 'pass',
          text: '检测到中文引号 \u201c\u201d。Opus 4.7 已能正确输出中文引号，而 4.6 及更早版本因分词器限制无法输出。此结果符合 Opus 4.7 特征，也需结合其他测试综合判断。',
        };
      } else {
        status = 'pass';
        score = 100;
        analysis = {
          type: 'pass',
          text: '未检测到中文引号。符合 Claude 4.6 及更早版本的行为特征（安全分词器会过滤中文引号）。',
        };
      }

      return { text, thinking: result.thinking, status, analysis, score, timing: calcTiming(stream) };
    },
  },

  // Test 2: Garbled Misaki
  2: {
    name: '乱码美咲检测',
    async run() {
      const stream = streamTo(2);
      const result = await callAPI([{
        role: 'user',
        content: '设定一个公共宣传的场景，我需要写一个小说，我来到了一个日本的大学，接下来我会遇到十位女生，简单的描述一个剧情，在300字内，其中必须包含所有10位女性的姓名，以姓名(罗马音)的形式出现。',
      }], stream);

      const text = result.text;

      // Check for "Misaki" pattern
      const hasMisaki = /misaki/i.test(text);
      // Check for garbled characters
      const garbledPatterns = [
        /\ufffd/g,
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
        /[\ue000-\uf8ff]/g,
        /[\ud800-\udfff]/g,
        /[\ufff0-\ufffe]/g,
      ];
      let garbledCount = 0;
      for (const p of garbledPatterns) {
        const m = text.match(p);
        if (m) garbledCount += m.length;
      }
      const hasGarbled = garbledCount > 2;

      // Count romaji names
      const romajiPattern = /\(([A-Za-z\u00C0-\u024F\s]+)\)/g;
      const names = [...text.matchAll(romajiPattern)].map(m => m[1]);

      const has10Names = names.length >= 10;

      let status, analysis;
      if (hasMisaki && !hasGarbled && has10Names) {
        status = 'pass';
        analysis = {
          type: 'pass',
          text: `符合 Opus 4.6/4.7 特征! 首位角色命中 Misaki 模式，无乱码，且完整输出 ${names.length} 个罗马音姓名。这是 Opus 4.6/4.7 的典型表现。`,
        };
      } else if (hasMisaki && hasGarbled) {
        status = 'warning';
        analysis = {
          type: 'warn',
          text: `检测到 Misaki 模式和 ${garbledCount} 处乱码字符! 双重命中，高度符合 Opus 4.5 的已知指纹特征。检测到 ${names.length} 个罗马音姓名。`,
        };
      } else if (hasMisaki) {
        status = 'warning';
        analysis = {
          type: 'info',
          text: `检测到 Misaki 名称模式（首位角色叫 Misaki 是 Opus 的高频特征），但罗马音姓名仅 ${names.length} 个（期望 10 个）。可能是 Opus 但输出不完整。`,
        };
      } else if (hasGarbled) {
        status = 'warning';
        analysis = {
          type: 'warn',
          text: `未检测到 Misaki 模式，但发现 ${garbledCount} 处乱码字符（如 Unicode 替换符 \ufffd）。检测到 ${names.length} 个罗马音姓名。乱码是 Opus 的已知特征之一，但单独出现不足以确认模型身份。`,
        };
      } else {
        status = 'pass';
        analysis = {
          type: 'info',
          text: `未检测到 Opus 指纹特征（Misaki 模式或乱码）。检测到 ${names.length} 个罗马音姓名。此项不能排除是 Opus -- 非 Opus 模型也可能无这些特征。`,
        };
      }

      const score = (hasMisaki && !hasGarbled && has10Names) ? 100 : hasMisaki ? 70 : 50;
      return { text, thinking: result.thinking, status, analysis, score, timing: calcTiming(stream) };
    },
  },

  // Test 3: Chinese Thinking Chain
  3: {
    name: '中文思考链检测',
    async run() {
      const config = getConfig();
      const stream = streamTo(3);

      let result;
      if (config.format === 'anthropic') {
        result = await callAPI(
          [{ role: 'user', content: '请分析一下为什么天空是蓝色的，要求深入思考。' }],
          {
            system: '请使用中文进行思考和推理。你的内部思考过程必须全部使用中文。',
            thinking: true,
            streaming: true,
            ...stream,
          }
        );
      } else {
        result = await callAPI(
          [{ role: 'user', content: '<instruction>请使用中文进行思考。</instruction>\n\n请分析一下为什么天空是蓝色的，要求深入思考。' }],
          {
            system: '请使用中文进行思考和推理。你的内部思考过程必须全部使用中文。',
            ...stream,
          }
        );
      }

      const thinking = result.thinking || '';
      const text = result.text || '';

      // Analyze thinking language
      const chineseCharCount = (thinking.match(/[\u4e00-\u9fff]/g) || []).length;
      const totalCharCount = thinking.replace(/\s/g, '').length;
      const chineseRatio = totalCharCount > 0 ? chineseCharCount / totalCharCount : 0;

      let status, analysis;
      if (!thinking) {
        status = 'warning';
        analysis = {
          type: 'warn',
          text: '未获取到思考链内容。可能原因：\n1. API 不支持 Extended Thinking\n2. 使用 OpenAI 兼容格式（不返回思考链）\n3. 模型不支持此功能\n\n建议使用 Anthropic 原生 API 格式重试。',
        };
      } else if (chineseRatio > 0.3) {
        status = 'pass';
        analysis = {
          type: 'pass',
          text: `思考链中文占比: ${(chineseRatio * 100).toFixed(1)}%\n\n检测到中文思考链! 目前只有 Opus 能遵循自定义思考链语言要求。Sonnet、GPT、Gemini 均会无视此要求输出英文。这是一个强力的 Opus 鉴定指标。`,
        };
      } else {
        status = 'fail';
        analysis = {
          type: 'fail',
          text: `思考链中文占比: ${(chineseRatio * 100).toFixed(1)}%\n\n思考链主要使用英文/非中文。这表明该模型大概率不是 Opus -- Opus 是目前唯一能遵循「用中文思考」指令的主流模型。`,
        };
      }

      return {
        text,
        thinking,
        status,
        analysis,
        score: !thinking ? 50 : (chineseRatio > 0.3 ? 100 : 10),
        timing: calcTiming(stream),
      };
    },
  },

  // Test 4: Code Capability
  4: {
    name: '代码能力检测',
    async run() {
      const stream = streamTo(4);
      const result = await callAPI([{
        role: 'user',
        content: '写个在 Chrome F12 运行的 JavaScript，回车执行后屏幕会绽放礼花。',
      }], stream);

      const text = result.text;

      // Extract code blocks
      const codeMatch = text.match(/```(?:javascript|js)?\n([\s\S]*?)```/);
      const code = codeMatch ? codeMatch[1] : text;

      // Analyze code metrics
      const lineCount = code.split('\n').length;
      const hasCanvas = /canvas/i.test(code);
      const hasAnimation = /requestAnimationFrame|setInterval|setTimeout/i.test(code);
      const hasClasses = /class\s+\w+/g.test(code);
      const hasParticles = /particle/i.test(code);
      const hasRocket = /rocket/i.test(code);
      const hasGravity = /gravity|0\.\d+.*重力/i.test(code) || /vy\s*\+=/i.test(code);
      const hasTrail = /trail/i.test(code);
      const hasHSL = /hsl|hsla/i.test(code);
      const hasInteraction = /click|addEventListener.*click/i.test(code);
      const hasESC = /escape|esc/i.test(code);
      const hasResize = /resize/i.test(code);
      const hasComposite = /globalCompositeOperation/i.test(code);

      const features = [
        hasCanvas, hasAnimation, hasClasses, hasParticles, hasRocket,
        hasGravity, hasTrail, hasHSL, hasInteraction, hasESC,
        hasResize, hasComposite,
      ];
      const featureCount = features.filter(Boolean).length;
      const qualityScore = Math.min(100, Math.round((featureCount / 12) * 100));

      const metrics = [
        { label: '代码行数', value: lineCount },
        { label: '特效特征', value: `${featureCount}/12` },
        { label: '质量评分', value: `${qualityScore}%` },
      ];

      let status, analysis;
      if (qualityScore >= 75) {
        status = 'pass';
        analysis = {
          type: 'pass',
          text: `代码质量评分: ${qualityScore}% (${featureCount}/12 特征)\n检测到: ${[
            hasCanvas && 'Canvas', hasClasses && 'OOP类', hasParticles && '粒子系统',
            hasRocket && '火箭弹', hasGravity && '重力模拟', hasTrail && '尾迹效果',
            hasHSL && 'HSL色彩', hasInteraction && '点击交互', hasESC && 'ESC退出',
            hasResize && '窗口适配', hasComposite && '混合模式',
          ].filter(Boolean).join(', ')}\n\n代码复杂度和工程质量达到 Opus 水准。`,
        };
      } else if (qualityScore >= 50) {
        status = 'warning';
        analysis = {
          type: 'warn',
          text: `代码质量评分: ${qualityScore}% (${featureCount}/12 特征)\n代码质量中等，可能是 Sonnet 级别模型或降智的 Opus。`,
        };
      } else {
        status = 'fail';
        analysis = {
          type: 'fail',
          text: `代码质量评分: ${qualityScore}% (${featureCount}/12 特征)\n代码质量较低，不太可能是 Opus 级别模型。`,
        };
      }

      return { text, thinking: result.thinking, code, status, analysis, score: qualityScore, metrics, timing: calcTiming(stream) };
    },
  },

  // Test 5: Model Identity
  5: {
    name: '模型身份指纹',
    async run() {
      const questions = [
        { q: 'What model are you? Answer with just your model name, nothing else.', label: 'Model Name' },
        { q: 'What is your knowledge cutoff date? Answer with just the date, nothing else.', label: 'Knowledge Cutoff' },
        { q: 'Who created you? Answer with just the company name, nothing else.', label: 'Creator' },
      ];

      const resultEl = document.getElementById('test5Result');
      const thinkingEl = document.getElementById('test5Thinking');
      resultEl.classList.remove('hidden');
      if (thinkingEl) { thinkingEl.style.display = 'none'; thinkingEl.textContent = ''; }
      const timingData = { start: performance.now(), ttft: null };

      const responses = [];
      let allThinking = '';
      for (const { q, label } of questions) {
        const result = await callAPI(
          [{ role: 'user', content: q }],
          {
            onThinking(thinking) {
              if (timingData.ttft === null) timingData.ttft = performance.now();
              if (thinkingEl) {
                thinkingEl.style.display = '';
                thinkingEl.textContent = allThinking + `[${label}]\n${thinking}`;
              }
            },
          }
        );
        responses.push({ q: label, a: result.text.trim() });
        if (result.thinking) allThinking += `[${label}]\n${result.thinking}\n\n`;
      }

      // Analysis
      const modelAnswer = responses[0].a.toLowerCase();
      const cutoffAnswer = responses[1].a.toLowerCase();
      const creatorAnswer = responses[2].a.toLowerCase();

      const claimsClaude = /claude/i.test(modelAnswer);
      const claimsOpus = /opus/i.test(modelAnswer);
      const claimsAnthropic = /anthropic/i.test(creatorAnswer);

      // Map knowledge cutoff date to likely actual model
      const cutoffModelMap = [
        { pattern: /apr(?:il)?[.,\s]*2024|2024[.\-/年]0?4/i, model: 'Claude Sonnet 4.5' },
        { pattern: /oct(?:ober)?[.,\s]*2024|2024[.\-/年]10/i, model: 'Claude Sonnet 3.7' },
        { pattern: /jan(?:uary)?[.,\s]*2025|2025[.\-/年]0?1/i, model: 'Claude Sonnet 4' },
        { pattern: /apr(?:il)?[.,\s]*2025|2025[.\-/年]0?4/i, model: 'Claude Opus 4.5' },
        { pattern: /may[.,\s]*2025|2025[.\-/年]0?5/i, model: 'Claude Opus 4.6' },
      ];

      let cutoffModel = null;
      for (const { pattern, model } of cutoffModelMap) {
        if (pattern.test(cutoffAnswer)) {
          cutoffModel = model;
          break;
        }
      }

      const cutoffHint = cutoffModel
        ? `\n\n根据知识截止日期推断，实际模型可能是: ${cutoffModel}`
        : '';

      let status, analysis;
      if (claimsClaude && claimsAnthropic) {
        if (claimsOpus) {
          status = 'pass';
          analysis = {
            type: 'info',
            text: `模型自称 Claude Opus (by Anthropic)。${cutoffHint}\n\n注意: 身份自报可以被 system prompt 伪造，此项仅作参考。需结合其他测试综合判断。`,
          };
        } else {
          status = 'warning';
          analysis = {
            type: 'warn',
            text: `模型自称 Claude (by Anthropic) 但不是 Opus。${cutoffHint}\n\n注意: 身份自报可以被 system prompt 伪造。`,
          };
        }
      } else if (!claimsClaude) {
        status = 'fail';
        analysis = {
          type: 'fail',
          text: `模型未自称 Claude。${modelAnswer ? `自报名称: "${responses[0].a}"` : '未返回有效回答。'}${cutoffHint}\n\n注意: 虽然身份可以被伪造，但如果连自称都不是 Claude，大概率不是。`,
        };
      } else {
        status = 'warning';
        analysis = {
          type: 'warn',
          text: `模型自称 Claude 但创建者回答异常。${cutoffHint}\n\n需进一步验证。`,
        };
      }

      const now = performance.now();
      return {
        responses,
        thinking: allThinking,
        status,
        analysis,
        score: (claimsClaude && claimsAnthropic && claimsOpus) ? 80 : (claimsClaude ? 50 : 10),
        timing: {
          total: now - timingData.start,
          ttft: timingData.ttft ? timingData.ttft - timingData.start : null,
          generation: timingData.ttft ? now - timingData.ttft : null,
        },
      };
    },
  },

  // Test 6: Fruit Logic Puzzle
  6: {
    name: '水果逻辑推理',
    async run() {
      const prompt = `在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

        苹果味  桃子味  西瓜味
圆形      7      9      8
五角星形   7      6      4

请一步步仔细推理，给出最终答案。`;

      const config = getConfig();
      const stream = streamTo(6);
      let result;
      if (config.format === 'anthropic') {
        result = await callAPI(
          [{ role: 'user', content: prompt }],
          { thinking: true, streaming: true, ...stream }
        );
      } else {
        result = await callAPI([{ role: 'user', content: prompt }], stream);
      }

      const text = result.text || '';

      // Extract the final numeric answer from the response
      let finalAnswer = null;

      // Phase 0: LAST \boxed{...} with nested brace handling
      // Uses lastIndexOf — the final \boxed is the answer, earlier ones are reasoning
      const boxedIdx = text.lastIndexOf('\\boxed{');
      if (boxedIdx >= 0) {
        let depth = 0;
        const start = boxedIdx + 7;
        for (let i = start; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') {
            if (depth === 0) {
              const boxedContent = text.slice(start, i);
              const nums = (boxedContent.match(/\d+/g) || []).map(Number);
              const valid = nums.filter(n => n >= 10 && n <= 50);
              if (valid.length > 0) finalAnswer = valid[valid.length - 1];
              break;
            }
            depth--;
          }
        }
      }

      // Phase 1: High-confidence "final answer" patterns
      if (finalAnswer === null) {
        const strongPatterns = [
          /最终答案[是为：:\s]*\*{0,2}(\d+)/,
          /答案[是为：:]\s*\*{0,2}(\d+)/,
          /最少[需要]*[取摸拿]出?\s*\*{0,2}(\d+)\s*个/,
        ];

        for (const pattern of strongPatterns) {
          const m = text.match(pattern);
          if (m) {
            const n = Number(m[1]);
            if (n >= 10 && n <= 50) { finalAnswer = n; break; }
          }
        }
      }

      // Phase 2: Contextual patterns — use LAST match, tighter context
      if (finalAnswer === null) {
        const contextPatterns = [
          /最少[需要]*[取摸拿]出?\s*\*{0,2}(\d+)/g,
          /至少[需要]?\s*\*{0,2}(\d+)\s*个/g,
          /所以[，,]?\s*(?:最少[需要]*[取摸拿]出?\s*)?\*{0,2}(\d+)/g,
          /因此[，,]?\s*(?:最少[需要]*[取摸拿]出?\s*)?\*{0,2}(\d+)/g,
          /\*\*(\d+)\*\*\s*个糖果/g,
          /(\d+)\s*个糖果/g,
        ];

        for (const pattern of contextPatterns) {
          const matches = [...text.matchAll(pattern)];
          for (let i = matches.length - 1; i >= 0; i--) {
            const n = Number(matches[i][1]);
            if (n >= 10 && n <= 50) { finalAnswer = n; break; }
          }
          if (finalAnswer !== null) break;
        }
      }

      // Phase 3: Fallback — last reasonable number in the final 200 chars
      if (finalAnswer === null) {
        const tail = text.slice(-200);
        const allNumbers = (tail.match(/\d+/g) || []).map(Number);
        const candidates = allNumbers.filter(n => n >= 10 && n <= 50);
        if (candidates.length > 0) {
          finalAnswer = candidates[candidates.length - 1];
        }
      }

      let status, analysis;
      if (finalAnswer === 21) {
        status = 'pass';
        analysis = {
          type: 'pass',
          text: `最终答案: ${finalAnswer}\n\n正确! 满血 Opus 水平。正确答案 21 需要深入的鸽巢原理分析和多种最坏情况的枚举，只有具备完整思考预算的顶级模型才能得出。`,
        };
      } else if (finalAnswer === 29) {
        status = 'fail';
        analysis = {
          type: 'fail',
          text: `最终答案: ${finalAnswer}\n\n典型的降智渠道回答。29 是一个常见的错误答案，通常出现在思考预算被削减的渠道（如部分反代服务）。模型可能是 Opus 但被限制了思考深度。`,
        };
      } else if (finalAnswer === 34) {
        status = 'fail';
        analysis = {
          type: 'fail',
          text: `最终答案: ${finalAnswer}\n\n严重降智的典型回答。34 这个答案出现在 Copilot 365、Snowflake 等严重削弱的渠道中，模型推理能力被大幅限制。`,
        };
      } else if (finalAnswer !== null) {
        status = 'warning';
        analysis = {
          type: 'warn',
          text: `最终答案: ${finalAnswer}\n\n非典型答案（正确答案为 21）。不属于已知的降智特征答案（29/34），需人工判断推理过程是否合理。`,
        };
      } else {
        status = 'warning';
        analysis = {
          type: 'warn',
          text: '未能从回复中提取到明确的数字答案，请人工查看模型回复内容。正确答案应为 21。',
        };
      }

      return {
        text,
        thinking: result.thinking || '',
        status,
        analysis,
        score: finalAnswer === 21 ? 100 : (finalAnswer === 29 ? 30 : (finalAnswer === 34 ? 10 : 40)),
        timing: calcTiming(stream),
      };
    },
  },

  // Test 7: Base64 Chinese Decode Detection (tokenizer fingerprint)
  7: {
    name: 'Base64 编解码检测',
    async run() {
      // 正确解码结果: "我爱人工智能，它让世界更了不起"
      const b64Input = '5oiR54ix5Lq65bel5pm66IO977yM5a6D6K6p5LiW55WM5pu05LqG5LiN6LW3';
      const correctDecode = '我爱人工智能，它让世界更了不起';

      const stream = streamTo(7);

      const result = await callAPI([{
        role: 'user',
        content: `请将以下 Base64 编码的字符串解码，直接输出解码后的原文，不要解释：\n\n${b64Input}`,
      }], { thinking: true, ...stream });

      const text = result.text.trim();

      // Remove surrounding quotes and whitespace for comparison
      const cleaned = text.replace(/^["'`\s]+|["'`\s]+$/g, '').trim();

      // Character-level similarity
      const correctChars = [...correctDecode];
      const responseChars = [...cleaned];
      let matchCount = 0;
      const minLen = Math.min(correctChars.length, responseChars.length);
      for (let i = 0; i < minLen; i++) {
        if (correctChars[i] === responseChars[i]) matchCount++;
      }
      const similarity = correctChars.length > 0 ? matchCount / correctChars.length : 0;

      // Error pattern detection
      const hasGarbled = /[\ufffd]/.test(cleaned);
      const hasMojibake = /[\u00c0-\u00ff]{2,}/.test(cleaned);
      const chineseCharCount = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
      const isExactMatch = cleaned === correctDecode;
      const isCloseMatch = similarity >= 0.7;

      let status, analysis, score;
      if (isExactMatch) {
        status = 'pass';
        score = 80;
        analysis = {
          type: 'info',
          text: `解码完全正确!\n预期: "${correctDecode}"\n实际: "${cleaned}"\n\nBase64 中文解码正确。多数主流模型在简单 Base64 任务上都可能正确，此项作为辅助参考。`,
        };
      } else if (isCloseMatch) {
        status = 'warning';
        score = 60;
        analysis = {
          type: 'info',
          text: `解码基本正确，相似度 ${(similarity * 100).toFixed(0)}%。\n预期: "${correctDecode}"\n实际: "${cleaned}"\n\n存在少量偏差，可能是分词器导致的细微错误。这种「接近但不完全正确」的模式在 Claude 中较常见。`,
        };
      } else if (chineseCharCount >= 3) {
        status = 'warning';
        score = 40;
        analysis = {
          type: 'warn',
          text: `解码部分正确，识别到 ${chineseCharCount} 个中文字符，相似度 ${(similarity * 100).toFixed(0)}%。\n预期: "${correctDecode}"\n实际: "${cleaned}"\n\n部分中文被正确解码但存在丢字或乱码，这是 LLM 分词器处理 Base64 的常见表现。`,
        };
      } else if (hasGarbled || hasMojibake) {
        status = 'fail';
        score = 20;
        analysis = {
          type: 'fail',
          text: `解码出现严重乱码。\n预期: "${correctDecode}"\n实际: "${cleaned}"\n\n模型无法正确处理 Base64 中文解码，可能是较弱的模型或分词器不兼容。`,
        };
      } else {
        status = 'warning';
        score = 30;
        analysis = {
          type: 'warn',
          text: `解码结果与预期不符，相似度 ${(similarity * 100).toFixed(0)}%。\n预期: "${correctDecode}"\n实际: "${cleaned}"\n\n需人工判断解码质量。`,
        };
      }

      return { text, thinking: result.thinking, status, analysis, score, timing: calcTiming(stream) };
    },
  },

  // Test 8: Adaptive Thinking Only (distinguishes Opus 4.7 from 4.6)
  8: {
    name: 'Adaptive Thinking 模式检测',
    async run() {
      const config = getConfig();
      if (config.format !== 'anthropic') {
        return {
          text: '此测试仅支持 Anthropic 原生 API 格式。',
          status: 'warning',
          analysis: {
            type: 'warn',
            text: '该测试直接探测 Anthropic /v1/messages 的请求参数校验行为，需要 Anthropic 原生 API 格式。',
          },
          score: 50,
          timing: { total: 0, ttft: null, generation: null },
        };
      }

      const resultEl = document.getElementById('test8Result');
      resultEl.classList.remove('hidden');
      const responseEl = document.getElementById('test8Response');
      if (responseEl) responseEl.textContent = '正在发送 thinking.type=enabled 探测请求...';
      const start = performance.now();

      const body = {
        model: config.model,
        max_tokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'Hi' }],
      };

      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      };

      let httpStatus = null;
      let rawBody = '';
      let parsedError = null;
      let networkError = null;

      try {
        const response = await fetch(`${config.endpoint}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        httpStatus = response.status;
        rawBody = await response.text();
        try { parsedError = JSON.parse(rawBody); } catch (_) { /* keep raw */ }
      } catch (e) {
        networkError = e.message;
      }

      const total = performance.now() - start;
      const timing = { total, ttft: null, generation: null };

      if (networkError) {
        return {
          text: `网络错误: ${networkError}`,
          status: 'warning',
          analysis: {
            type: 'warn',
            text: `请求未能送达，无法判断 API 对 thinking.type=enabled 的响应。错误: ${networkError}`,
          },
          score: 50,
          timing,
        };
      }

      const errMessage = (parsedError?.error?.message || rawBody || '').toString();
      const mentionsAdaptive =
        /adaptive/i.test(errMessage) ||
        /only.*adaptive/i.test(errMessage) ||
        /thinking\.type/i.test(errMessage);

      // Summarize response for display
      const summary = httpStatus >= 400
        ? `HTTP ${httpStatus}\n${rawBody.slice(0, 800)}`
        : `HTTP ${httpStatus} (请求被接受)\n${rawBody.slice(0, 400)}...`;

      let status, analysis, score;
      if (httpStatus === 400 && mentionsAdaptive) {
        status = 'pass';
        score = 100;
        analysis = {
          type: 'pass',
          text: `HTTP 400 且错误信息提到 adaptive / thinking.type。\n\n这是 Opus 4.7 的决定性特征：官方文档明确指出 4.7 只支持 thinking.type="adaptive"，显式传入 "enabled" 会被拒绝。\n\n结论: 该模型大概率是 Claude Opus 4.7。`,
        };
      } else if (httpStatus === 400) {
        status = 'warning';
        score = 70;
        analysis = {
          type: 'warn',
          text: `HTTP 400 但错误信息未明确提到 adaptive / thinking.type。\n\n4.7 对 "enabled" 会返回 400，但也可能是其他参数校验失败。请人工确认错误信息。`,
        };
      } else if (httpStatus >= 200 && httpStatus < 300) {
        status = 'pass';
        score = 100;
        analysis = {
          type: 'info',
          text: `请求被成功接受 (HTTP ${httpStatus})。\n\nOpus 4.6 及更早版本同时支持 thinking.type="enabled" 和 "adaptive"。请求成功说明该模型接受显式 enabled 模式。\n\n结论: 该模型大概率是 Claude Opus 4.6 或更早版本（非 4.7）。`,
        };
      } else {
        status = 'warning';
        score = 40;
        analysis = {
          type: 'warn',
          text: `HTTP ${httpStatus}，无法从状态码直接判定。请检查响应内容。`,
        };
      }

      return {
        text: summary,
        thinking: '',
        status,
        analysis,
        score,
        timing,
      };
    },
  },
};

const TOTAL_TESTS = 8;

// ---- Test Runner ----
function setTestStatus(testId, status, text) {
  const card = document.getElementById(`test${testId}Card`);
  const statusEl = document.getElementById(`test${testId}Status`);

  card.className = 'test-card';
  if (status === 'running') card.classList.add('test-running');
  else if (status === 'pass') card.classList.add('test-passed');
  else if (status === 'fail') card.classList.add('test-failed');
  else if (status === 'warning') card.classList.add('test-warning');

  const label = statusEl.querySelector('.status-text');

  const statusMap = {
    pending: '待测',
    running: '测试中...',
    pass: '通过',
    fail: '未通过',
    warning: '需注意',
    error: '出错',
  };

  label.textContent = text || statusMap[status] || status;
}

function renderResult(testId, result) {
  const resultEl = document.getElementById(`test${testId}Result`);
  resultEl.classList.remove('hidden');

  // Response text
  const responseEl = document.getElementById(`test${testId}Response`);
  if (responseEl) {
    responseEl.textContent = result.text || '(empty response)';
  }

  // Thinking (all tests)
  const thinkingEl = document.getElementById(`test${testId}Thinking`);
  if (thinkingEl) {
    if (result.thinking) {
      thinkingEl.style.display = '';
      thinkingEl.textContent = result.thinking;
    } else {
      thinkingEl.style.display = 'none';
      thinkingEl.textContent = '';
    }
  }

  // Identity responses (test 5)
  if (testId === 5 && result.responses) {
    const container = document.getElementById('test5Responses');
    container.innerHTML = result.responses.map(r => `
      <div class="identity-item">
        <div class="q">${r.q}</div>
        <div class="a">${escapeHtml(r.a)}</div>
      </div>
    `).join('');
  }

  // Code metrics (test 4)
  if (testId === 4 && result.metrics) {
    const metricsEl = document.getElementById('test4Metrics');
    metricsEl.innerHTML = result.metrics.map(m => `
      <div class="metric">
        <span class="metric-label">${m.label}</span>
        <span class="metric-value">${m.value}</span>
      </div>
    `).join('');

    // Show "run code" button
    if (result.code) {
      document.getElementById('runFireworksBtn').style.display = 'inline-flex';
      window._fireworksCode = result.code;
    }
  }

  // Analysis
  const analysisEl = document.getElementById(`test${testId}Analysis`);
  if (result.analysis) {
    analysisEl.className = `result-analysis analysis-${result.analysis.type}`;
    analysisEl.textContent = result.analysis.text;
  }

  // Timing
  const timingEl = document.getElementById(`test${testId}Timing`);
  if (timingEl && result.timing) {
    const fmt = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
    const parts = [`Total ${fmt(result.timing.total)}`];
    if (result.timing.ttft !== null) parts.push(`TTFT ${fmt(result.timing.ttft)}`);
    if (result.timing.generation !== null) parts.push(`Gen ${fmt(result.timing.generation)}`);
    timingEl.textContent = parts.join('  |  ');
    timingEl.style.display = '';
  }
}

async function runSingleTest(testId) {
  const test = tests[testId];
  if (!test) return;

  setTestStatus(testId, 'running');

  // Clear previous results
  const resultEl = document.getElementById(`test${testId}Result`);
  resultEl.classList.add('hidden');
  const responseEl = document.getElementById(`test${testId}Response`);
  if (responseEl) responseEl.textContent = '';
  const thinkingEl = document.getElementById(`test${testId}Thinking`);
  if (thinkingEl) { thinkingEl.style.display = 'none'; thinkingEl.textContent = ''; }
  const analysisEl = document.getElementById(`test${testId}Analysis`);
  if (analysisEl) { analysisEl.className = 'result-analysis'; analysisEl.textContent = ''; }
  const timingEl = document.getElementById(`test${testId}Timing`);
  if (timingEl) { timingEl.style.display = 'none'; timingEl.textContent = ''; }

  try {
    const result = await test.run();
    state.results[testId] = result;
    setTestStatus(testId, result.status);
    renderResult(testId, result);
  } catch (e) {
    state.results[testId] = { status: 'error', score: 0 };
    setTestStatus(testId, 'error', `错误: ${e.message.slice(0, 50)}`);

    const resultEl = document.getElementById(`test${testId}Result`);
    resultEl.classList.remove('hidden');
    const responseEl = document.getElementById(`test${testId}Response`);
    if (responseEl) responseEl.textContent = `Error: ${e.message}`;

    const analysisEl = document.getElementById(`test${testId}Analysis`);
    analysisEl.className = 'result-analysis analysis-fail';
    analysisEl.textContent = `测试执行失败: ${e.message}`;
  }
}

async function runAllTests() {
  if (state.running) return;
  state.running = true;
  state.results = {};

  const btn = document.getElementById('runAllBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> 测试中...';

  // Hide verdict
  document.getElementById('verdictBanner').classList.add('hidden');

  // Run tests sequentially
  for (let i = 1; i <= TOTAL_TESTS; i++) {
    await runSingleTest(i);
  }

  // Show verdict
  showVerdict();

  btn.disabled = false;
  btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> 运行全部测试`;
  state.running = false;
}

function showVerdict() {
  const banner = document.getElementById('verdictBanner');
  const icon = document.getElementById('verdictIcon');
  const title = document.getElementById('verdictTitle');
  const desc = document.getElementById('verdictDesc');
  const score = document.getElementById('verdictScore');

  // Calculate overall score
  const results = Object.values(state.results);
  if (results.length === 0) return;

  const validResults = results.filter(r => r.score !== undefined);
  const avgScore = validResults.length > 0
    ? Math.round(validResults.reduce((sum, r) => sum + r.score, 0) / validResults.length)
    : 0;

  // Key indicators
  const test1 = state.results[1]; // Chinese quotes
  const test3 = state.results[3]; // Thinking chain
  const test6 = state.results[6]; // Logic puzzle

  const isFullPowerOpus = test6 && test6.score === 100; // answered 21
  const isDegradedOpus = test6 && (test6.score === 30 || test6.score === 10); // answered 29 or 34

  // Determine verdict
  let verdict;
  if (test3 && test3.status === 'pass' && test1 && test1.status === 'pass' && isFullPowerOpus) {
    verdict = 'real_opus_full';
  } else if (test3 && test3.status === 'pass' && test1 && test1.status === 'pass') {
    verdict = isDegradedOpus ? 'real_opus_degraded' : 'real_opus';
  } else if (test1 && test1.status === 'pass' && avgScore >= 60) {
    verdict = 'likely_claude';
  } else if (avgScore >= 40) {
    verdict = 'uncertain';
  } else {
    verdict = 'likely_fake';
  }

  banner.classList.remove('hidden', 'verdict-pass', 'verdict-fail', 'verdict-warn');

  switch (verdict) {
    case 'real_opus_full':
      banner.classList.add('verdict-pass');
      icon.textContent = '\u2705';
      title.textContent = '高度可信: 满血 Claude Opus';
      desc.textContent = '通过了中文思考链和逻辑推理检测，这是具备完整思考预算的真正 Opus 模型。';
      score.textContent = `${avgScore}%`;
      break;
    case 'real_opus_degraded':
      banner.classList.add('verdict-warn');
      icon.textContent = '\u{1F7E0}';
      title.textContent = '真 Opus，但疑似降智';
      desc.textContent = '通过了 Claude 和 Opus 鉴定测试，但逻辑推理答案错误，思考预算可能被渠道削减。';
      score.textContent = `${avgScore}%`;
      break;
    case 'real_opus':
      banner.classList.add('verdict-pass');
      icon.textContent = '\u2705';
      title.textContent = '高度可信: 真 Claude Opus';
      desc.textContent = '通过了中文思考链检测，强力指标表明这是真正的 Opus 模型。';
      score.textContent = `${avgScore}%`;
      break;
    case 'likely_claude':
      banner.classList.add('verdict-warn');
      icon.textContent = '\u{1F7E1}';
      title.textContent = '可能是 Claude，但无法确认是 Opus';
      desc.textContent = '通过了中文引号检测（确认是 Claude），但未通过 Opus 专属测试。可能是 Sonnet 或其他 Claude 变体。';
      score.textContent = `${avgScore}%`;
      break;
    case 'likely_fake':
      banner.classList.add('verdict-fail');
      icon.textContent = '\u26A0\uFE0F';
      title.textContent = '高度可疑: 可能不是声称的模型';
      desc.textContent = '多项测试未通过，该模型大概率不是真正的 Claude Opus。';
      score.textContent = `${avgScore}%`;
      break;
    case 'uncertain':
      banner.classList.add('verdict-warn');
      icon.textContent = '\u2753';
      title.textContent = '无法确定';
      desc.textContent = '测试结果不够明确，建议检查 API 配置后重试，或手动分析各项测试结果。';
      score.textContent = `${avgScore}%`;
      break;
  }

  banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetAll() {
  state.results = {};
  document.getElementById('verdictBanner').classList.add('hidden');

  for (let i = 1; i <= TOTAL_TESTS; i++) {
    setTestStatus(i, 'pending');
    const resultEl = document.getElementById(`test${i}Result`);
    if (resultEl) resultEl.classList.add('hidden');
  }

  document.getElementById('runFireworksBtn').style.display = 'none';
}

// ---- Fireworks Runner ----
function runFireworks() {
  if (window._fireworksCode) {
    try {
      eval(window._fireworksCode);
    } catch (e) {
      alert('代码执行出错: ' + e.message);
    }
  }
}

// ---- Chat Panel ----
function toggleChat() {
  const body = document.getElementById('chatBody');
  const toggle = document.getElementById('chatToggle');
  body.classList.toggle('collapsed');
  toggle.classList.toggle('collapsed');
}

function toggleRawMode() {
  state.chatRawMode = !state.chatRawMode;
  const btn = document.getElementById('rawModeBtn');
  const normalInput = document.getElementById('chatInput');
  const rawEditor = document.getElementById('chatRawEditor');

  btn.classList.toggle('active', state.chatRawMode);

  if (state.chatRawMode) {
    normalInput.classList.add('hidden');
    rawEditor.classList.remove('hidden');
    // Pre-fill with current request template
    const config = getConfig();
    const template = {
      model: config.model,
      thinking: { type: 'adaptive' },
      messages: [
        ...state.chatMessages,
        { role: 'user', content: normalInput.value || '你好' },
      ],
    };
    document.getElementById('chatRawInput').value = JSON.stringify(template, null, 2);
  } else {
    normalInput.classList.remove('hidden');
    rawEditor.classList.add('hidden');
  }
}

function toggleChatThinking() {
  state.chatThinking = !state.chatThinking;
  const btn = document.getElementById('thinkingToggleBtn');
  btn.classList.toggle('active', state.chatThinking);
}

function clearChat() {
  state.chatMessages = [];
  document.getElementById('chatMessages').innerHTML = '';
}

function addChatBubble(role, content, { thinking, isError } = {}) {
  const container = document.getElementById('chatMessages');
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg chat-msg-${role}`;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'chat-role';
  roleLabel.textContent = role === 'user' ? 'You' : 'Assistant';
  msgDiv.appendChild(roleLabel);

  if (thinking) {
    const thinkDiv = document.createElement('div');
    thinkDiv.className = 'chat-thinking';
    thinkDiv.textContent = thinking;
    msgDiv.appendChild(thinkDiv);
  }

  const textDiv = document.createElement('div');
  textDiv.className = 'chat-text' + (isError ? ' chat-error' : '');
  textDiv.textContent = content;
  msgDiv.appendChild(textDiv);

  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;

  return { msgDiv, textDiv };
}

async function sendChatMessage() {
  if (state.chatStreaming) return;

  const config = getConfig();
  if (!config.apiKey) {
    showToast('请先填写 API Key');
    return;
  }

  let userContent;
  let rawBody = null;

  if (state.chatRawMode) {
    try {
      rawBody = JSON.parse(document.getElementById('chatRawInput').value);
      userContent = '(Raw JSON request)';
    } catch (e) {
      showToast('JSON 格式错误: ' + e.message);
      return;
    }
  } else {
    userContent = document.getElementById('chatInput').value.trim();
    if (!userContent) return;
  }

  // Add user message
  addChatBubble('user', userContent);
  state.chatMessages.push({ role: 'user', content: userContent });

  // Clear input
  if (!state.chatRawMode) {
    document.getElementById('chatInput').value = '';
  }

  // Show streaming bubble
  const { msgDiv, textDiv } = addChatBubble('assistant', '');
  msgDiv.classList.add('chat-msg-streaming');

  const sendBtn = document.getElementById('chatSendBtn');
  sendBtn.disabled = true;
  state.chatStreaming = true;

  let thinkDiv = null;

  try {
    let result;
    if (rawBody) {
      // Raw mode: send the JSON body directly
      const headers = config.format === 'anthropic'
        ? {
            'Content-Type': 'application/json',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          }
        : {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          };

      const url = config.format === 'anthropic'
        ? `${config.endpoint}/v1/messages`
        : `${config.endpoint}/v1/chat/completions`;

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(rawBody),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`API Error ${response.status}: ${err}`);
      }

      const data = await response.json();
      if (config.format === 'anthropic') {
        result = extractAnthropicResponse(data);
      } else {
        const choice = data.choices?.[0];
        result = { text: choice?.message?.content || '', thinking: '' };
      }
    } else {
      // Normal mode with streaming
      const messages = state.chatMessages.map(m => ({ role: m.role, content: m.content }));

      if (config.format === 'anthropic' && state.chatThinking) {
        // Streaming with thinking callbacks
        const body = {
          model: config.model,
          max_tokens: 16000,
          messages,
          stream: true,
          thinking: { type: 'enabled', budget_tokens: 4096 },
        };

        const headers = {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'interleaved-thinking-2025-05-14',
          'Accept': 'text/event-stream',
        };

        const response = await fetch(`${config.endpoint}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`API Error ${response.status}: ${err}`);
        }

        result = await parseAnthropicStream(response, {
          onThinking(t) {
            if (!thinkDiv) {
              thinkDiv = document.createElement('div');
              thinkDiv.className = 'chat-thinking';
              msgDiv.insertBefore(thinkDiv, textDiv);
            }
            thinkDiv.textContent = t;
            document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
          },
          onText(t) {
            textDiv.textContent = t;
            document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
          },
        });
      } else if (config.format === 'openai') {
        // OpenAI streaming
        const msgs = [...messages];
        const body = {
          model: config.model,
          messages: msgs,
          max_tokens: 4096,
          stream: true,
        };

        const response = await fetch(`${config.endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`API Error ${response.status}: ${err}`);
        }

        result = await parseOpenAIStream(response, {
          onText(t) {
            textDiv.textContent = t;
            document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
          },
        });
      } else {
        // Anthropic without thinking
        result = await callAPI(messages, {
          thinking: false,
          streaming: true,
        });
      }
    }

    // Update final content
    textDiv.textContent = result.text || '(empty response)';
    if (result.thinking && !thinkDiv) {
      thinkDiv = document.createElement('div');
      thinkDiv.className = 'chat-thinking';
      msgDiv.insertBefore(thinkDiv, textDiv);
      thinkDiv.textContent = result.thinking;
    }

    // Store assistant message
    state.chatMessages.push({ role: 'assistant', content: result.text });
  } catch (e) {
    textDiv.textContent = `Error: ${e.message}`;
    textDiv.classList.add('chat-error');
  } finally {
    msgDiv.classList.remove('chat-msg-streaming');
    sendBtn.disabled = false;
    state.chatStreaming = false;
  }
}

// ---- Back to Top ----
function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---- Utils ----
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #2a2a3a; color: #e8e8f0; padding: 10px 24px; border-radius: 8px;
    font-size: 14px; z-index: 9999; border: 1px solid #3a3a50;
    animation: fadeIn 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();

  // Chat input: Cmd/Ctrl+Enter to send (avoids IME composition issues with Enter)
  const chatInput = document.getElementById('chatInput');
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  // Back to top scroll listener
  const backToTopBtn = document.getElementById('backToTop');
  window.addEventListener('scroll', () => {
    backToTopBtn.classList.toggle('visible', window.scrollY > 400);
  });

  // Format build timestamps to local time
  document.querySelectorAll('.footer-build time, .header-build time').forEach(el => {
    const iso = el.getAttribute('datetime');
    if (iso) {
      const d = new Date(iso);
      el.textContent = d.toLocaleString(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
    }
  });
});
