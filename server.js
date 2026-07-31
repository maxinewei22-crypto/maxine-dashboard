/**
 * Maxine Creator Dashboard - Server
 *
 * Usage:
 *   1. Create .env with API keys (see .env.example)
 *   2. Run: node server.js
 *   3. Server runs on http://localhost:3000
 *
 * Supports: OpenAI official API / Aliyun DashScope (OpenAI-compatible mode)
 *
 * Endpoints:
 *   POST /api/analyze-video   - Analyze a video (AI)
 *   POST /api/ocr-metrics     - OCR screenshot metrics (AI Vision)
 *   GET  /api/health          - Check server status
 *   GET  /api/reflections     - List all reflections
 *   POST /api/reflections     - Create a reflection (AI auto-classify + profile update)
 *   DELETE /api/reflections/:id - Delete a reflection
 *   POST /api/ask-advice      - AI life coach Q&A (with context)
 */

// Load .env before other modules
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const reflectionRouter = require('./server/routes/reflection');
const diagnosisRouter = require('./server/routes/diagnosis');
const { setupSync } = require('./server/sync');

const app = express();
const PORT = process.env.PORT || 3000;

// Create HTTP server (for both Express and Socket.IO)
const server = http.createServer(app);

// Setup Socket.IO with CORS
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 100 * 1024 * 1024 // 100MB
});

// Setup real-time sync module
setupSync(io);

// Unified API key: prefer DASHSCOPE_API_KEY (Aliyun), fallback to OPENAI_API_KEY
const OPENAI_API_KEY = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const API_PROVIDER = process.env.API_PROVIDER || 'openai'; // 'openai' or 'claude'

// Model mapping for different providers
const AI_MODEL_ANALYZE = process.env.AI_MODEL_ANALYZE || (OPENAI_BASE_URL.includes('dashscope') ? 'qwen-plus' : 'gpt-4o');
const AI_MODEL_OCR = process.env.AI_MODEL_OCR || (OPENAI_BASE_URL.includes('dashscope') ? 'qwen-vl-max' : 'gpt-4o-mini');
const AI_MODEL_REFLECT = process.env.AI_MODEL_REFLECT || (OPENAI_BASE_URL.includes('dashscope') ? 'qwen-turbo' : 'gpt-4o-mini');

// ========== Middleware ==========

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Body parser
app.use(express.json({ limit: '600mb' }));

// ========== Static Files ==========

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'creator-dashboard.html');
  if (fs.existsSync(htmlPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(htmlPath);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Serve PWA static files (manifest, icons, sw.js)
const staticFiles = {
  '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json' },
  '/sw.js': { file: 'sw.js', type: 'application/javascript' },
  '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
  '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
  '/icon-192-maskable.png': { file: 'icon-192-maskable.png', type: 'image/png' },
  '/icon-512-maskable.png': { file: 'icon-512-maskable.png', type: 'image/png' },
  '/icon-512.jpg': { file: 'icon-512.jpg', type: 'image/jpeg' },
  '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' },
  '/favicon.png': { file: 'favicon.png', type: 'image/png' }
};

Object.entries(staticFiles).forEach(([route, config]) => {
  app.get(route, (req, res) => {
    const filePath = path.join(__dirname, config.file);
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', config.type);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(filePath);
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

// ========== Reflection Routes ==========

app.use('/api/reflections', reflectionRouter);

// ========== Diagnosis Routes ==========

app.use('/api/diagnosis', diagnosisRouter);

// ========== API: Analyze Video ==========

app.post('/api/analyze-video', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error: 'Server API Key not configured. Please set OPENAI_API_KEY environment variable.'
    });
  }

  try {
    const videoUrl = req.body.url;

    if (!videoUrl || !videoUrl.trim()) {
      return res.status(400).json({ error: 'Missing video URL' });
    }

    const validPlatforms = ['douyin.com', 'bilibili.com', 'xiaohongshu.com'];
    if (!validPlatforms.some(p => videoUrl.includes(p))) {
      return res.status(400).json({
        error: 'Invalid URL. Only Douyin, Bilibili, and Xiaohongshu links are supported.'
      });
    }

    const result = API_PROVIDER === 'claude'
      ? await callClaude(videoUrl.trim())
      : await callOpenAI(videoUrl.trim());

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// ========== API: OCR Metrics ==========

app.post('/api/ocr-metrics', async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'API Key not configured. Please set OPENAI_API_KEY environment variable.'
    });
  }

  try {
    const imageBase64 = req.body.image;

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid image data' });
    }

    if (!imageBase64.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image format. Expected data:image/...' });
    }

    const result = await callOpenAIVision(imageBase64);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('OCR error:', err.message);
    res.status(500).json({ error: err.message || 'OCR failed' });
  }
});

// ========== API: Health Check ==========

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    apiConfigured: !!OPENAI_API_KEY,
    provider: API_PROVIDER,
    baseUrl: OPENAI_BASE_URL,
    models: {
      analyze: AI_MODEL_ANALYZE,
      ocr: AI_MODEL_OCR,
      reflect: AI_MODEL_REFLECT
    }
  });
});

// ========== 404 ==========

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ========== AI Service Functions ==========

async function callOpenAI(videoUrl) {
  const systemPrompt = `你是一位资深短视频内容分析师，拥有多年抖音、B站、小红书平台内容运营经验。你的任务是根据用户提供的视频链接，生成一份专业的视频分析报告。

请严格按照以下JSON格式返回分析结果，所有字段必须包含：

{
  "overview": {
    "title": "视频标题（根据链接推断或通用标题）",
    "platform": "平台名称（抖音/B站/小红书）",
    "duration": "预估时长",
    "views": "预估播放量级别"
  },
  "rhythm": {
    "hookStrength": 85,
    "infoDensity": 72,
    "climaxPosition": 90,
    "endingConversion": 68,
    "analysis": "节奏分析文字描述，具体指出视频在哪些时间点使用了什么节奏技巧"
  },
  "copywriting": {
    "structure": "文案结构分析（开头-中间-结尾）",
    "techniques": ["话术技巧1", "话术技巧2", "话术技巧3"],
    "memoryPoints": "记忆点分布分析"
  },
  "visual": {
    "composition": 80,
    "colorUsage": 75,
    "effects": 70,
    "analysis": "视觉表现具体分析"
  },
  "audio": {
    "pace": 78,
    "tone": 82,
    "bgmFit": 76,
    "analysis": "音频/口播质量分析"
  },
  "pros": [
    "优点1：具体且有针对性，结合视频内容",
    "优点2：具体且有针对性",
    "优点3：具体且有针对性"
  ],
  "cons": [
    "不足1：具体且有针对性",
    "不足2：具体且有针对性"
  ],
  "suggestions": [
    "优化建议1：针对不足给出可执行的改进方案",
    "优化建议2：针对不足给出可执行的改进方案",
    "优化建议3：针对不足给出可执行的改进方案"
  ],
  "score": 8.5,
  "comparison": "与同领域竞品对比参考分析"
}

重要要求：
1. 所有分析必须具体、有针对性，避免笼统描述
2. 要结合视频内容给出具体证据（例如："在第15秒处，通过快速剪辑制造了悬念"）
3. 评分使用百分制（0-100）或10分制，需有明确依据
4. 优点和不足各至少3条和2条
5. 优化建议必须可执行、具体
6. 只返回JSON，不要返回任何其他文字`;

  const userPrompt = `请分析以下视频链接，生成专业的视频分析报告：\n\n视频链接：${videoUrl}\n\n请基于该平台的内容特点、用户画像和算法机制进行分析。`;

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL_ANALYZE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 2500
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Invalid response format from AI');
  return JSON.parse(jsonMatch[0]);
}

async function callClaude(videoUrl) {
  const systemPrompt = `你是一位资深短视频内容分析师，拥有多年抖音、B站、小红书平台内容运营经验。你的任务是根据用户提供的视频链接，生成一份专业的视频分析报告。

请严格按照以下JSON格式返回分析结果，所有字段必须包含：

{
  "overview": {
    "title": "视频标题（根据链接推断或通用标题）",
    "platform": "平台名称（抖音/B站/小红书）",
    "duration": "预估时长",
    "views": "预估播放量级别"
  },
  "rhythm": {
    "hookStrength": 85,
    "infoDensity": 72,
    "climaxPosition": 90,
    "endingConversion": 68,
    "analysis": "节奏分析文字描述，具体指出视频在哪些时间点使用了什么节奏技巧"
  },
  "copywriting": {
    "structure": "文案结构分析（开头-中间-结尾）",
    "techniques": ["话术技巧1", "话术技巧2", "话术技巧3"],
    "memoryPoints": "记忆点分布分析"
  },
  "visual": {
    "composition": 80,
    "colorUsage": 75,
    "effects": 70,
    "analysis": "视觉表现具体分析"
  },
  "audio": {
    "pace": 78,
    "tone": 82,
    "bgmFit": 76,
    "analysis": "音频/口播质量分析"
  },
  "pros": [
    "优点1：具体且有针对性，结合视频内容",
    "优点2：具体且有针对性",
    "优点3：具体且有针对性"
  ],
  "cons": [
    "不足1：具体且有针对性",
    "不足2：具体且有针对性"
  ],
  "suggestions": [
    "优化建议1：针对不足给出可执行的改进方案",
    "优化建议2：针对不足给出可执行的改进方案",
    "优化建议3：针对不足给出可执行的改进方案"
  ],
  "score": 8.5,
  "comparison": "与同领域竞品对比参考分析"
}

重要要求：
1. 所有分析必须具体、有针对性，避免笼统描述
2. 要结合视频内容给出具体证据（例如："在第15秒处，通过快速剪辑制造了悬念"）
3. 评分使用百分制（0-100）或10分制，需有明确依据
4. 优点和不足各至少3条和2条
5. 优化建议必须可执行、具体
6. 只返回JSON，不要返回任何其他文字`;

  const userPrompt = `请分析以下视频链接，生成专业的视频分析报告：\n\n视频链接：${videoUrl}\n\n请基于该平台的内容特点、用户画像和算法机制进行分析。`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': OPENAI_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.content[0].text;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Invalid response format from AI');
  return JSON.parse(jsonMatch[0]);
}

async function callOpenAIVision(imageBase64) {
  const systemPrompt = `你是一位精确的数字识别专家。请仔细查看这张短视频后台数据截图，从中提取三个关键数字：昨日播放量、预估收益（人民币元）、新增粉丝数（可正可负）。
请以 JSON 格式返回，例如：
{"playCount": 12100, "revenue": 393, "fansChange": -194}
如果某个数字无法看清或不存在，对应字段返回 null。
只返回 JSON，不要其他文字。`;

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL_OCR,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: systemPrompt },
          { type: 'image_url', image_url: { url: imageBase64 } }
        ]
      }],
      max_tokens: 200,
      temperature: 0
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI Vision API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Invalid JSON response from vision model');
  return JSON.parse(jsonMatch[0]);
}

// ========== Start Server ==========

server.listen(PORT, () => {
  console.log(`\n🚀 Maxine Dashboard Server running at http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT} (Socket.IO)`);
  console.log(`📊 API Provider: ${API_PROVIDER}`);
  console.log(`🌐 Base URL: ${OPENAI_BASE_URL}`);
  console.log(`🔑 API Key: ${OPENAI_API_KEY ? '✅ Configured' : '❌ Not configured'}`);
  console.log(`🤖 Models: analyze=${AI_MODEL_ANALYZE}, ocr=${AI_MODEL_OCR}, reflect=${AI_MODEL_REFLECT}`);
  console.log(`\n📖 Endpoints:`);
  console.log(`   POST /api/analyze-video    - Analyze a video`);
  console.log(`   POST /api/ocr-metrics      - OCR screenshot metrics`);
  console.log(`   POST /api/reflections      - Create a reflection (AI classify)`);
  console.log(`   GET  /api/reflections      - List all reflections`);
  console.log(`   DELETE /api/reflections/:id - Delete a reflection`);
  console.log(`   POST /api/ask-advice       - AI life coach Q&A`);
  console.log(`   POST /api/diagnosis/topic   - Topic evaluation`);
  console.log(`   POST /api/diagnosis/script  - Script diagnosis`);
  console.log(`   POST /api/diagnosis/comment - Comment insight (multimodal)`);
  console.log(`   POST /api/diagnosis/ocr-comments - OCR comments from screenshots`);
  console.log(`   POST /api/diagnosis/audio-to-text - Audio to text`);
  console.log(`   POST /api/diagnosis/video-to-text - Video to text`);
  console.log(`   POST /api/diagnosis/generate-script - AI Creative Workshop`);
  console.log(`   POST /api/diagnosis/extract-video-content - Extract video content`);
  console.log(`   POST /api/diagnosis/analyze-keyframes - Analyze keyframes`);
  console.log(`   GET  /api/diagnosis/script-history - Script history`);
  console.log(`   GET  /api/diagnosis/growth-log - Growth log`);
  console.log(`   GET  /api/health           - Check server status`);
  console.log(`\n💡 To start with Aliyun DashScope:`);
  console.log(`   DASHSCOPE_API_KEY=sk-xxx OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 node server.js`);
  console.log(`\n`);
});