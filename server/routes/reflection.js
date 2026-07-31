/**
 * Reflection Module - CRUD + AI Classification Router
 *
 * Data store: server/data/db.json (reflections array + user_profile)
 */

const fs = require('fs');
const path = require('path');
const { Router } = require('express');

const router = Router();
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

// Unified API config: prefer DASHSCOPE_API_KEY (Aliyun), fallback to OPENAI_API_KEY
const OPENAI_API_KEY = process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const AI_MODEL = process.env.AI_MODEL_REFLECT || process.env.AI_MODEL || (OPENAI_BASE_URL.includes('dashscope') ? 'qwen-turbo' : 'gpt-4o-mini');

// ========== Helpers ==========

function readDB() {
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Merge AI profile_update into existing user_profile.
 * Arrays: deduplicated append. Strings: direct overwrite.
 */
function mergeProfile(existing, update) {
  if (!update) return existing;
  const result = { ...existing };

  // interests, current_goals, frequent_pain_points, personality_traits → arrays
  const arrayFields = ['interests', 'current_goals', 'frequent_pain_points', 'personality_traits'];
  for (const field of arrayFields) {
    if (Array.isArray(update[field])) {
      const existingArr = Array.isArray(result[field]) ? result[field] : [];
      const merged = [...existingArr];
      for (const item of update[field]) {
        const trimmed = (item || '').trim();
        if (trimmed && !merged.some(m => m.toLowerCase() === trimmed.toLowerCase())) {
          merged.push(trimmed);
        }
      }
      result[field] = merged;
    }
  }

  // learning_habits → string
  if (update.learning_habits !== undefined && update.learning_habits !== null) {
    result.learning_habits = update.learning_habits;
  }

  result.last_updated = new Date().toISOString();
  return result;
}

// ========== AI Helpers ==========

/**
 * Call OpenAI Chat Completions API and return parsed JSON or text.
 */
async function callAI(systemPrompt, userPrompt, parseJSON = true) {
  if (!OPENAI_API_KEY) {
    throw new Error('AI_API_KEY_NOT_CONFIGURED');
  }

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
      temperature: 0.5,
      max_tokens: 1500
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
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

// ========== Routes ==========

// GET /api/reflections — 按时间倒序返回全部记录
router.get('/', (req, res) => {
  try {
    const db = readDB();
    const reflections = (db.reflections || []).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    res.json({ success: true, data: reflections, profile: db.user_profile || {} });
  } catch (err) {
    console.error('GET /api/reflections error:', err.message);
    res.status(500).json({ error: 'Failed to read reflections' });
  }
});

// POST /api/reflections — 创建反思记录 + AI自动分类与画像更新
router.post('/', async (req, res) => {
  try {
    const { type, content, category, attachments } = req.body;

    // Validate required fields
    if (!type || !content) {
      return res.status(400).json({
        error: 'Missing required fields: type and content are required'
      });
    }

    // Validate type
    const validTypes = ['daily', 'weekly', 'project', 'learning', 'creative'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Invalid type. Must be one of: ${validTypes.join(', ')}`
      });
    }

    const db = readDB();

    // ---------- AI: 自动分类 + 画像提取 ----------
    let aiCategory = category || 'general';
    let aiTags = [];
    let profileUpdate = null;

    try {
      const classifyPrompt = `分析用户输入，返回JSON：
{
  "category": "反思/读书笔记/随想/问题/其他",
  "tags": ["关键词1","关键词2","关键词3"],
  "profile_update": {
    "interests": [],
    "current_goals": [],
    "pain_points": [],
    "traits": [],
    "learning_habits": ""
  }
}
只返回JSON，不要返回任何其他文字。`;

      const aiResult = await callAI(classifyPrompt, `用户反思内容：\n类型：${type}\n内容：${content}`, true);

      if (aiResult.category) aiCategory = aiResult.category;
      if (Array.isArray(aiResult.tags)) aiTags = aiResult.tags;
      if (aiResult.profile_update) profileUpdate = aiResult.profile_update;

      console.log(`[AI Classification] category=${aiCategory}, tags=${aiTags.length}`);
    } catch (aiErr) {
      // AI 不可用时降级：使用前端传来的 category，跳过画像更新
      console.warn('[AI Classification] AI unavailable, using fallback:', aiErr.message);
    }

    // ---------- 构建记录 ----------
    const newReflection = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      type,
      content,
      category: aiCategory,
      tags: aiTags,
      attachments: attachments || [],
      aiProcessed: !!profileUpdate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.reflections.push(newReflection);

    // ---------- 合并画像 ----------
    if (profileUpdate) {
      db.user_profile = mergeProfile(db.user_profile || {}, profileUpdate);
      console.log('[Profile Updated] interests:', (db.user_profile.interests || []).length);
    }

    writeDB(db);

    res.status(201).json({ success: true, data: newReflection });
  } catch (err) {
    console.error('POST /api/reflections error:', err.message);
    res.status(500).json({ error: 'Failed to create reflection' });
  }
});

// DELETE /api/reflections/:id — 删除指定记录
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const db = readDB();

    const index = db.reflections.findIndex(r => r.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Reflection not found' });
    }

    const deleted = db.reflections.splice(index, 1)[0];
    writeDB(db);

    res.json({ success: true, data: deleted });
  } catch (err) {
    console.error('DELETE /api/reflections/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete reflection' });
  }
});

// ========== POST /api/ask-advice — AI人生教练问答 ==========

router.post('/ask-advice', async (req, res) => {
  try {
    const { question } = req.body;

    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Missing required field: question' });
    }

    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        error: 'AI service unavailable. Please set OPENAI_API_KEY environment variable.'
      });
    }

    const db = readDB();

    // 组装上下文：最近30条反思 + 完整用户画像
    const recentReflections = (db.reflections || [])
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 30)
      .map((r, i) => `[${i + 1}] (${r.type}/${r.category}) ${r.createdAt.slice(0, 10)}: ${r.content}`)
      .join('\n');

    const userProfile = db.user_profile || {};
    const profileText = [
      `兴趣：${(userProfile.interests || []).join('、') || '暂无'}`,
      `当前目标：${(userProfile.current_goals || []).join('、') || '暂无'}`,
      `常见痛点：${(userProfile.frequent_pain_points || []).join('、') || '暂无'}`,
      `性格特质：${(userProfile.personality_traits || []).join('、') || '暂无'}`,
      `学习习惯：${userProfile.learning_habits || '暂无'}`
    ].join('\n');

    const systemPrompt = `你是用户的人生教练和成长顾问。你的使命是根据用户的历史反思记录和用户画像，给出有深度、有针对性的建议。

已知用户画像：
${profileText}

用户最近记录（最近30条）：
${recentReflections || '暂无记录'}

回答要求：
1. 必须引述用户的历史记录来支撑你的建议（如"你在7月20日的反思中提到..."）
2. 给出具体、可执行的建议，而非空泛的鸡汤
3. 语气亲切但专业，像一个有经验的朋友
4. 使用中文回答
5. 返回纯文本回答，不要使用Markdown格式`;

    const answer = await callAI(systemPrompt, `用户问题：${question}`, false);

    res.json({ success: true, data: { answer, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('POST /api/ask-advice error:', err.message);

    if (err.message === 'AI_API_KEY_NOT_CONFIGURED') {
      return res.status(503).json({
        error: 'AI service unavailable. Please set OPENAI_API_KEY environment variable.'
      });
    }

    res.status(500).json({ error: 'Failed to get advice: ' + err.message });
  }
});

module.exports = router;
