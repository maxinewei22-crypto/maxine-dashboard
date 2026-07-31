/**
 * Creative Diagnosis Module - AI Analysis + Growth Log
 *
 * Endpoints:
 *   POST /api/diagnosis/topic      - 选题热度评估
 *   POST /api/diagnosis/script     - 脚本诊断
 *   POST /api/diagnosis/comment    - 评论洞察（多模态：text/image/audio/video）
 *   POST /api/diagnosis/ocr-comments - 截图OCR识别评论
 *   POST /api/diagnosis/audio-to-text - 语音转文字
 *   POST /api/diagnosis/video-to-text - 视频提取音频转文字
 *   POST /api/diagnosis/generate-script - AI创作工坊（生成完整方案）
 *   POST /api/diagnosis/extract-video-content - 视频提取内容
 *   POST /api/diagnosis/analyze-keyframes - 关键帧分析
 *   GET  /api/diagnosis/script-history - 脚本历史列表
 *   DELETE /api/diagnosis/script-history/:id - 删除脚本历史
 *   GET  /api/diagnosis/growth-log - 成长日志列表
 *   DELETE /api/diagnosis/growth-log/:id - 删除日志
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('express');

const router = Router();
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

// Unified API config
const OPENAI_API_KEY = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL_ANALYZE || process.env.AI_MODEL || (OPENAI_BASE_URL.includes('dashscope') ? 'qwen-plus' : 'gpt-4o');
const AI_MODEL_VL = process.env.AI_MODEL_OCR || (OPENAI_BASE_URL.includes('dashscope') ? 'qwen-vl-max' : 'gpt-4o-mini');
const AI_MODEL_TURBO = process.env.AI_MODEL_REFLECT || (OPENAI_BASE_URL.includes('dashscope') ? 'qwen-turbo' : 'gpt-4o-mini');

// ========== Helpers ==========

function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function ensureGrowthLog(db) {
  if (!Array.isArray(db.growth_log)) db.growth_log = [];
  return db.growth_log;
}

function ensureScriptHistory(db) {
  if (!Array.isArray(db.script_history)) db.script_history = [];
  return db.script_history;
}

function addScriptHistory(inputType, inputSummary, theme, script, storyboard, tags) {
  const db = readDB();
  const history = ensureScriptHistory(db);
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    inputType,
    inputSummary,
    theme,
    script,
    storyboard,
    tags: tags || [],
    createdAt: new Date().toISOString()
  };
  history.unshift(entry);
  if (history.length > 50) history.length = 50;
  writeDB(db);
  return entry;
}

function addGrowthLog(type, summary, improvements, extra) {
  const db = readDB();
  const log = ensureGrowthLog(db);
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    type,
    summary,
    improvements: improvements || [],
    timestamp: new Date().toISOString()
  };
  if (extra && typeof extra === 'object') {
    Object.assign(entry, extra);
  }
  log.unshift(entry);
  // Keep max 100 entries
  if (log.length > 100) log.length = 100;
  writeDB(db);
  return entry;
}

async function callAI(systemPrompt, userPrompt, parseJSON) {
  if (!OPENAI_API_KEY) throw new Error('AI_API_KEY_NOT_CONFIGURED');

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  if (parseJSON) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid JSON response from AI');
    return JSON.parse(jsonMatch[0]);
  }
  return content;
}

/**
 * Call Vision-Language model with image(s) — returns parsed JSON or text
 */
async function callVisionAI(systemPrompt, images, parseJSON) {
  if (!OPENAI_API_KEY) throw new Error('AI_API_KEY_NOT_CONFIGURED');

  const userContent = [
    { type: 'text', text: systemPrompt }
  ];
  for (const img of images) {
    userContent.push({ type: 'image_url', image_url: { url: img } });
  }

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL_VL,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0.1,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vision AI error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  if (parseJSON) {
    // Try to find JSON array or object
    const jsonMatch = content.match(/\[[\s\S]*\]/) || content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid JSON response from Vision AI');
    return JSON.parse(jsonMatch[0]);
  }
  return content;
}

/**
 * Call audio transcription via Paraformer (DashScope) or Whisper-compatible endpoint.
 * Falls back to text prompt if audio API unavailable.
 */
async function callAudioToText(audioBase64) {
  if (!OPENAI_API_KEY) throw new Error('AI_API_KEY_NOT_CONFIGURED');

  // DashScope Paraformer audio API (compatible mode)
  // We use the multi-modal conversation API with audio input
  const isDashScope = OPENAI_BASE_URL.includes('dashscope');

  if (isDashScope) {
    // Use qwen-audio-turbo for audio understanding via DashScope compatible mode
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'qwen-audio-turbo',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '请将这段语音转录为文字，只返回转写文本，不要添加任何其他内容。' },
            { type: 'audio_url', audio_url: { url: audioBase64 } }
          ]
        }],
        temperature: 0.1,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Audio AI error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }

  // Fallback: OpenAI Whisper API
  // Parse base64 data URL to get raw audio
  const audioMatch = audioBase64.match(/^data:audio\/(\w+);base64,(.+)$/);
  if (!audioMatch) throw new Error('Invalid audio format');

  const audioBuffer = Buffer.from(audioMatch[2], 'base64');
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer]), `audio.${audioMatch[1]}`);
  formData.append('model', 'whisper-1');

  const response = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.text || '';
}

// ========== Routes ==========

// POST /api/diagnosis/topic - 选题热度评估
router.post('/topic', async (req, res) => {
  try {
    const { topic, description } = req.body;
    if (!topic || !topic.trim()) {
      return res.status(400).json({ error: 'Missing required field: topic' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    const systemPrompt = `你是拥有百万粉丝的短视频导师。用户是一个刚开始做抖音的新手，目前只有5个粉丝。请评估用户提供的选题，从以下维度给出建议：

1. 选题热度评分（0-100）及理由
2. 受众痛点匹配度（这个内容能戳中哪些人的什么痛点）
3. 差异化分析（这个选题是否同质化，如何差异化切入）
4. 爆款潜力评估（用🔥表示，最多5个🔥）
5. 给新手的执行难度评级（用⭐表示，最多5个⭐，越多越难）

输出格式为JSON：
{
  "heat_score": 0,
  "heat_reason": "理由",
  "pain_points": "受众痛点匹配度分析",
  "differentiation": "差异化分析",
  "viral_potential": "🔥🔥🔥",
  "difficulty": "⭐⭐",
  "suggestions": ["建议1", "建议2", "建议3"]
}
只返回JSON，不要返回任何其他文字。`;

    const userPrompt = `选题：${topic}\n${description ? '补充描述：' + description : ''}`;

    const result = await callAI(systemPrompt, userPrompt, true);

    // Auto-record growth log
    const improvements = result.suggestions || [];
    const log = addGrowthLog('topic_evaluation', `选题评估: ${topic.slice(0, 30)}`, improvements);

    res.json({ success: true, data: result, growth_log: log });
  } catch (err) {
    console.error('POST /api/diagnosis/topic error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Diagnosis failed: ' + err.message });
  }
});

// POST /api/diagnosis/script - 脚本诊断
router.post('/script', async (req, res) => {
  try {
    const { script, title } = req.body;
    if (!script || !script.trim()) {
      return res.status(400).json({ error: 'Missing required field: script' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    const systemPrompt = `你是拥有百万粉丝的短视频导师。请分析用户提供的视频脚本草稿，从新手容易犯的错误角度给出诊断：

1. 开头3秒钩子强度（0-100分）——新手最常见的错误是开头太平淡
2. 信息密度评估（是否太慢或太快）
3. 结构完整性（是否有清晰的开头-中间-结尾）
4. 观众留存预测（哪个时间点最容易流失）
5. 3条具体可执行的改进建议（用"立即执行"清单格式）

输出格式为JSON：
{
  "hook_strength": 0,
  "hook_analysis": "开头钩子分析",
  "info_density": "信息密度评估",
  "structure": "结构完整性分析",
  "retention_risk": "观众留存预测",
  "action_items": [
    {"title": "改进项", "detail": "具体操作", "priority": "high/medium/low"}
  ]
}
只返回JSON，不要返回任何其他文字。`;

    const userPrompt = `${title ? '标题：' + title + '\n' : ''}脚本内容：\n${script}`;

    const result = await callAI(systemPrompt, userPrompt, true);

    const improvements = (result.action_items || []).map(a => a.title);
    const log = addGrowthLog('script_diagnosis', `脚本诊断: ${(title || script.slice(0, 20))}`, improvements);

    res.json({ success: true, data: result, growth_log: log });
  } catch (err) {
    console.error('POST /api/diagnosis/script error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Diagnosis failed: ' + err.message });
  }
});

// POST /api/diagnosis/comment - 评论洞察（多模态）
router.post('/comment', async (req, res) => {
  try {
    const { comments, videoTitle, inputType, images, audioBase64, videoBase64 } = req.body;
    const actualInputType = inputType || 'text';

    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    let finalComments = comments || '';
    let sourceNote = '';
    let ocrCount = 0;

    // ===== Step 1: Convert multimodal input to text =====
    if (actualInputType === 'image' && images && images.length > 0) {
      // OCR: extract comments from screenshot(s)
      const ocrPrompt = '请识别这张/这些评论区截图中的所有评论文字，按行输出为JSON数组，每条评论为数组中的一个字符串。只返回JSON数组，不要其他文字。';
      const ocrResult = await callVisionAI(ocrPrompt, images, true);
      if (Array.isArray(ocrResult)) {
        finalComments = ocrResult.join('\n');
        ocrCount = ocrResult.length;
      } else if (typeof ocrResult === 'string') {
        finalComments = ocrResult;
        ocrCount = ocrResult.split('\n').filter(l => l.trim()).length;
      }
      sourceNote = `来自截图识别，共识别${ocrCount}条评论`;
    } else if (actualInputType === 'audio' && audioBase64) {
      // Audio to text
      finalComments = await callAudioToText(audioBase64);
      sourceNote = '来自语音转写';
    } else if (actualInputType === 'video' && videoBase64) {
      // Video: extract audio frames then transcribe
      // For video, we use qwen-vl-max to analyze key frames + extract text
      const videoOcrPrompt = '这是一个视频的截图/帧。请识别其中出现的所有评论文本内容，按行输出为JSON数组，每条评论为字符串。只返回JSON数组。';
      const videoResult = await callVisionAI(videoOcrPrompt, [videoBase64], true);
      if (Array.isArray(videoResult)) {
        finalComments = videoResult.join('\n');
        ocrCount = videoResult.length;
      } else {
        finalComments = typeof videoResult === 'string' ? videoResult : '';
      }
      sourceNote = `来自视频提取，共识别${ocrCount}条评论`;
    }

    if (!finalComments || !finalComments.trim()) {
      return res.status(400).json({ error: '未能提取到有效评论内容，请检查输入或切换到文字粘贴模式' });
    }

    // ===== Step 2: Analyze comments with AI =====
    const systemPrompt = `你是资深短视频运营专家。以下是用户视频的评论区内容（来源可能是：用户粘贴的文字、截图OCR识别的评论、语音转写的口述评论、视频提取的评论）。

请分析这些评论，从创作者成长角度给出以下维度的反馈（输出JSON格式）：

1. 整体情绪倾向：{ positive: x%, negative: x%, neutral: x% }
2. 高频关键词：[词1, 词2, 词3, 词4, 词5]
3. 负面反馈归类：{ content_value: "内容价值问题", production_quality: "制作质量问题", expression: "表达方式问题", other: "其他问题" }
4. 下期改进方向：[建议1, 建议2, 建议3]
5. 评论区互动建议：[{ comment: "评论摘要", reply_strategy: "回复建议", priority: "high/medium/low" }]
6. 用户画像洞察：从评论中推断出观众是谁、他们想要什么

输出格式为JSON：
{
  "sentiment": {"positive": 60, "negative": 20, "neutral": 20},
  "top_keywords": ["关键词1", "关键词2", "关键词3", "关键词4", "关键词5"],
  "negative_categories": {
    "content_value": "内容价值问题分析",
    "production_quality": "制作质量问题分析",
    "expression": "表达方式问题分析",
    "other": "其他问题"
  },
  "improvement_directions": ["改进方向1", "改进方向2", "改进方向3"],
  "interaction_suggestions": [
    {"comment": "评论内容摘要", "reply_strategy": "回复建议", "priority": "high/medium/low"}
  ],
  "user_profile_insight": "用户画像洞察文字"
}
只返回JSON，不要返回任何其他文字。`;

    const userPrompt = `${videoTitle ? '视频标题：' + videoTitle + '\n' : ''}评论区内容：\n${finalComments}`;

    const result = await callAI(systemPrompt, userPrompt, true);

    // Add source info to result
    if (sourceNote) {
      result.source_note = sourceNote;
      result.input_type = actualInputType;
      result.comment_count = ocrCount || finalComments.split('\n').filter(l => l.trim()).length;
    }

    const improvements = result.improvement_directions || [];
    const logExtra = sourceNote ? { inputType: actualInputType, sourceNote } : {};
    const log = addGrowthLog('comment_insight', `评论洞察: ${(videoTitle || '视频评论分析')}`, improvements, logExtra);

    res.json({ success: true, data: result, growth_log: log });
  } catch (err) {
    console.error('POST /api/diagnosis/comment error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Diagnosis failed: ' + err.message });
  }
});

// POST /api/diagnosis/ocr-comments - 截图OCR识别评论
router.post('/ocr-comments', async (req, res) => {
  try {
    const { images } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Missing required field: images (array of base64 strings)' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    const ocrPrompt = '请识别这张/这些评论区截图中的所有评论文字，按行输出为JSON数组，每条评论为数组中的一个字符串。只返回JSON数组，不要其他文字。';
    const result = await callVisionAI(ocrPrompt, images, true);

    const comments = Array.isArray(result) ? result : [];
    res.json({ success: true, data: { comments, count: comments.length } });
  } catch (err) {
    console.error('POST /api/diagnosis/ocr-comments error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'OCR failed: ' + err.message });
  }
});

// POST /api/diagnosis/audio-to-text - 语音转文字
router.post('/audio-to-text', async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'Missing required field: audioBase64' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    const text = await callAudioToText(audioBase64);
    res.json({ success: true, data: { text } });
  } catch (err) {
    console.error('POST /api/diagnosis/audio-to-text error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Audio transcription failed: ' + err.message });
  }
});

// POST /api/diagnosis/video-to-text - 视频提取音频+转文字
router.post('/video-to-text', async (req, res) => {
  try {
    const { videoBase64 } = req.body;
    if (!videoBase64) {
      return res.status(400).json({ error: 'Missing required field: videoBase64' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    // Use vision model to analyze video frames (DashScope qwen-vl-max supports video_url)
    const videoPrompt = '请分析这个视频中的所有评论相关内容，提取出所有评论文字，按行输出为JSON数组，每条评论为字符串。如果视频中没有评论区内容，请描述视频主要内容。只返回JSON数组。';
    const result = await callVisionAI(videoPrompt, [videoBase64], true);

    const comments = Array.isArray(result) ? result : [];
    const text = Array.isArray(result) ? result.join('\n') : String(result);

    res.json({ success: true, data: { text, comments, count: comments.length } });
  } catch (err) {
    console.error('POST /api/diagnosis/video-to-text error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Video processing failed: ' + err.message });
  }
});

// GET /api/diagnosis/growth-log - 成长日志列表
router.get('/growth-log', (req, res) => {
  try {
    const db = readDB();
    const log = ensureGrowthLog(db);
    res.json({ success: true, data: log });
  } catch (err) {
    console.error('GET /api/diagnosis/growth-log error:', err.message);
    res.status(500).json({ error: 'Failed to read growth log' });
  }
});

// DELETE /api/diagnosis/growth-log/:id - 删除日志
router.delete('/growth-log/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = readDB();
    const log = ensureGrowthLog(db);
    const index = log.findIndex(e => e.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Growth log entry not found' });
    }
    const deleted = log.splice(index, 1)[0];
    writeDB(db);
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('DELETE /api/diagnosis/growth-log/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete growth log entry' });
  }
});

// ========== AI创作工坊 (Generate Script) ==========

// POST /api/diagnosis/generate-script - 生成完整创作方案
router.post('/generate-script', async (req, res) => {
  try {
    const { inputType, videoBase64, documentText, ideaText, supplement, linkUrl, platform } = req.body;
    const actualInputType = inputType || 'idea';

    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    let analysisResult = '';
    let inputSummary = '';

    // ===== Step 1: Analyze input based on type =====
    if (actualInputType === 'video' && videoBase64) {
      inputSummary = '视频文件分析';
      // Use vision model to analyze video content
      const videoAnalysisPrompt = `你是一位拥有10年经验的短视频导演和内容策划专家。用户上传了一个视频，请从以下维度深度分析：

1. 视频主题是什么？核心卖点是什么？
2. 目标受众是谁？他们为什么会对这个内容感兴趣？
3. 内容结构是怎样的？（开头-中间-结尾的逻辑）
4. 视觉风格和剪辑节奏如何？
5. 文案话术有哪些亮点和不足？
6. 这个视频的爆款潜质在哪里？哪些地方可以改进？

请输出JSON格式：
{
  "topic": "视频主题",
  "coreSellingPoint": "核心卖点",
  "targetAudience": "目标受众分析",
  "structureAnalysis": "内容结构分析",
  "visualStyle": "视觉风格评价",
  "scriptHighlights": "文案亮点",
  "scriptWeakness": "文案不足",
  "viralPotential": "爆款潜质分析",
  "improvementSuggestions": ["改进建议1", "改进建议2"]
}
只返回JSON，不要其他文字。`;

      try {
        analysisResult = await callVisionAI(videoAnalysisPrompt, [videoBase64], false);
      } catch (vlErr) {
        // Fallback: if video too large or VL fails, try text-based analysis
        analysisResult = '视频分析降级：由于视频处理限制，将基于用户补充描述生成方案。';
      }
    } else if (actualInputType === 'link' && linkUrl) {
      inputSummary = (platform || '链接') + ': ' + linkUrl.slice(0, 60);
      const linkAnalysisPrompt = `你是一位顶尖的短视频内容策划。用户提供了一个${platform || '短视频'}作品链接，希望基于该作品的风格和结构，创作一个类似定位的新视频方案。

请注意：你无法直接访问该链接，但请根据平台特征（${platform || '短视频平台'}）和链接信息，从以下维度进行分析并生成创作方案：

1. 该平台的内容调性是什么？（如抖音偏娱乐/种草，B站偏深度/知识，小红书偏生活方式/种草）
2. 该类平台高互动内容的共同特征是什么？
3. 基于平台特性，推测该作品可能的主题方向和内容结构
4. 如果要创作一个同类型的新视频，应该从哪些角度切入才能出彩？
5. 针对该平台用户的痛点和兴趣点，给出差异化创作建议

请输出JSON格式：
{
  "coreTopic": "核心主题方向",
  "targetAudience": "目标人群画像",
  "platformCharacteristics": "平台内容调性分析",
  "viralPatterns": ["该平台高互动特征1", "特征2", "特征3"],
  "contentStructure": "推测的内容结构",
  "differentiation": "差异化创作建议",
  "improvementSuggestions": ["具体建议1", "具体建议2"]
}
只返回JSON，不要其他文字。`;

      const linkInput = '链接：' + linkUrl + (supplement ? '\n\n补充描述：' + supplement : '');
      analysisResult = await callAI(linkAnalysisPrompt, linkInput, false);
    } else if (actualInputType === 'document' && documentText) {
      inputSummary = documentText.slice(0, 50);
      const docAnalysisPrompt = `你是一位顶尖的短视频内容策划。用户提供了一份文案/脚本，请从以下维度深度分析：

1. 核心主题提炼（一句话概括）
2. 目标人群画像（年龄、兴趣、痛点）
3. 内容价值点（用户能获得什么）
4. 现有文案/想法的优势和不足
5. 改进建议（如何让内容更吸引人）

请输出JSON格式：
{
  "coreTopic": "核心主题",
  "targetAudience": "目标人群画像",
  "contentValue": "内容价值点",
  "strengths": ["优势1", "优势2"],
  "weaknesses": ["不足1", "不足2"],
  "improvementSuggestions": ["改进建议1", "改进建议2"]
}
只返回JSON，不要其他文字。`;

      analysisResult = await callAI(docAnalysisPrompt, documentText, false);
    } else if (actualInputType === 'idea' && ideaText) {
      inputSummary = ideaText.slice(0, 50);
      const ideaAnalysisPrompt = `你是一位顶尖的短视频内容策划。用户提供了一个创作想法/选题方向，请从以下维度深度分析：

1. 核心主题提炼（一句话概括）
2. 目标人群画像（年龄、兴趣、痛点）
3. 内容价值点（用户能获得什么）
4. 这个想法的优势和潜在风险
5. 改进建议（如何让内容更吸引人）

请输出JSON格式：
{
  "coreTopic": "核心主题",
  "targetAudience": "目标人群画像",
  "contentValue": "内容价值点",
  "strengths": ["优势1", "优势2"],
  "risks": ["风险1", "风险2"],
  "improvementSuggestions": ["改进建议1", "改进建议2"]
}
只返回JSON，不要其他文字。`;

      const ideaInput = ideaText + (supplement ? '\n\n补充描述：' + supplement : '');
      analysisResult = await callAI(ideaAnalysisPrompt, ideaInput, false);
    } else {
      return res.status(400).json({ error: '请提供有效的输入内容（视频/文案/想法）' });
    }

    // ===== Step 2: Generate complete plan based on analysis =====
    const generatePrompt = `基于以上分析结果，请为这个短视频生成完整的创作方案。

分析结果：
${analysisResult}

${supplement ? '用户补充要求：' + supplement : ''}

请输出JSON格式（严格遵守以下结构）：
{
  "theme": {
    "title": "视频主标题",
    "subtitle": "副标题或slogan",
    "targetAudience": "目标人群描述",
    "coreValue": "核心卖点/价值主张",
    "tone": "情绪基调",
    "benchmarkAccounts": ["对标账号1", "对标账号2", "对标账号3"],
    "potentialScore": 4.5
  },
  "script": {
    "titles": ["爆款标题1", "爆款标题2", "爆款标题3"],
    "hook": "开头0-5秒逐字稿",
    "body": [
      {"section": "第一部分", "content": "逐字稿内容", "duration": "30秒", "keyPoint": "核心信息点"}
    ],
    "ending": "结尾引导话术",
    "totalWords": 500,
    "estimatedDuration": "3:20"
  },
  "storyboard": [
    {"shot": 1, "scene": "景别", "visual": "画面描述", "dialogue": "台词", "duration": "5秒", "bgm": "背景音乐建议", "notes": "备注"}
  ],
  "tags": ["标签1", "标签2"]
}

要求：
- theme.potentialScore 为0-5的数字（保留一位小数）
- script.body 至少3个段落
- storyboard 至少5个分镜
- 所有内容必须具体可执行，不要泛泛而谈
- 只返回JSON，不要其他文字`;

    const planResult = await callAI(generatePrompt, '请生成完整创作方案', true);

    // Merge analysis into result
    const finalResult = {
      ...planResult,
      analysis: analysisResult.slice(0, 500),
      inputType: actualInputType
    };

    // Save to script_history
    const tags = planResult.tags || [];
    const historyEntry = addScriptHistory(
      actualInputType,
      inputSummary,
      planResult.theme || {},
      planResult.script || {},
      planResult.storyboard || [],
      tags
    );

    // Also add to growth log
    addGrowthLog('script_generation', `AI创作工坊: ${inputSummary}`, tags);

    res.json({ success: true, data: finalResult, history: historyEntry });
  } catch (err) {
    console.error('POST /api/diagnosis/generate-script error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});

// POST /api/diagnosis/extract-video-content - 视频提取内容
router.post('/extract-video-content', async (req, res) => {
  try {
    const { videoBase64 } = req.body;
    if (!videoBase64) {
      return res.status(400).json({ error: 'Missing required field: videoBase64' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    // Use vision model to extract content from video
    const extractPrompt = '请分析这个视频的内容。提取以下信息：1. 视频中的语音/台词内容（转写为文字）2. 主要画面场景描述 3. 视频整体主题。请输出JSON格式：{"audioText": "语音转写文字", "scenes": ["场景1", "场景2"], "mainTopic": "主题"}。只返回JSON。';
    const result = await callVisionAI(extractPrompt, [videoBase64], true);

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/diagnosis/extract-video-content error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Video extraction failed: ' + err.message });
  }
});

// POST /api/diagnosis/analyze-keyframes - 关键帧分析
router.post('/analyze-keyframes', async (req, res) => {
  try {
    const { keyframes } = req.body;
    if (!keyframes || !Array.isArray(keyframes) || keyframes.length === 0) {
      return res.status(400).json({ error: 'Missing required field: keyframes (array of base64 images)' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'AI service unavailable. Please set API key.' });
    }

    const analyzePrompt = '请分析这些视频关键帧图片，描述每帧的画面内容、场景、人物动作、情绪和视觉风格。输出JSON数组：[{"frame": 1, "scene": "场景", "action": "人物动作", "emotion": "情绪", "visualStyle": "视觉风格"}]。只返回JSON。';
    const result = await callVisionAI(analyzePrompt, keyframes, true);

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/diagnosis/analyze-keyframes error:', err.message);
    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'AI service unavailable.' });
    }
    res.status(500).json({ error: 'Keyframe analysis failed: ' + err.message });
  }
});

// GET /api/diagnosis/script-history - 脚本历史列表
router.get('/script-history', (req, res) => {
  try {
    const db = readDB();
    const history = ensureScriptHistory(db);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error('GET /api/diagnosis/script-history error:', err.message);
    res.status(500).json({ error: 'Failed to read script history' });
  }
});

// DELETE /api/diagnosis/script-history/:id - 删除脚本历史
router.delete('/script-history/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = readDB();
    const history = ensureScriptHistory(db);
    const index = history.findIndex(e => e.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Script history entry not found' });
    }
    const deleted = history.splice(index, 1)[0];
    writeDB(db);
    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('DELETE /api/diagnosis/script-history/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete script history entry' });
  }
});

module.exports = router;
