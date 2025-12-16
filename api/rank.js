'use strict';

const RECIPES = require('../recipes-data.js');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 5);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const allowedOrigins = ALLOWED_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const rateLimitStore = new Map();

function isOriginAllowed(origin) {
  if (!origin || !allowedOrigins.length) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

function applyCorsHeaders(res, origin) {
  if (!origin || typeof res.setHeader !== 'function') {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function getClientKey(req) {
  const header = req.headers?.['x-forwarded-for'] || req.headers?.['x-real-ip'];
  if (typeof header === 'string' && header.length > 0) {
    return header.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function takeRateLimitSlot(key, now) {
  const entries = rateLimitStore.get(key) || [];
  const recent = entries.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitStore.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimitStore.set(key, recent);
  return true;
}

function respond(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  if (typeof res.status === 'function') {
    res.status(statusCode);
  } else {
    res.statusCode = statusCode;
  }
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json');
  }
  if (typeof res.json === 'function') {
    res.json(payload);
    return;
  }
  if (typeof res.send === 'function') {
    res.send(body);
    return;
  }
  if (typeof res.end === 'function') {
    res.end(body);
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  let raw = '';
  return new Promise((resolve) => {
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

async function handler(req, res) {
  const origin = req.headers?.origin;
  if (origin && !isOriginAllowed(origin)) {
    respond(res, 403, { error: 'Origin not allowed.' });
    return;
  }
  if (origin) {
    applyCorsHeaders(res, origin);
  }

  if (req.method === 'OPTIONS') {
    if (typeof res.status === 'function') {
      res.status(204);
    } else {
      res.statusCode = 204;
    }
    if (typeof res.end === 'function') {
      res.end();
    }
    return;
  }

  if (req.method && req.method !== 'POST') {
    respond(res, 405, { error: 'Method not allowed. Use POST.' });
    return;
  }

  const clientKey = getClientKey(req);
  const now = Date.now();
  if (!takeRateLimitSlot(clientKey, now)) {
    respond(res, 429, { error: 'Rate limit exceeded. Please wait a moment and try again.' });
    return;
  }

  const parsedBody = await parseBody(req);
  if (parsedBody === null) {
    respond(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const userQuery = (parsedBody.query || '').trim();
  if (!userQuery) {
    respond(res, 400, { error: 'Query is required.' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    respond(res, 500, { error: 'Server misconfiguration: missing OpenAI API key.' });
    return;
  }

  const recipeContext = RECIPES.map((recipe) => `${recipe.id} | ${recipe.title} | ${recipe.details}`).join('\n');
  const payload = {
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You rank recipes from the provided list. Respond with JSON only using this shape: {"primary":"R##","secondary":["R##","R##"]}. Choose the closest match for primary and the next two closest for secondary. Never invent new recipes, never summarize.'
      },
      {
        role: 'user',
        content: `Recipe list:\n${recipeContext}\n\nUser request: ${userQuery}\nReturn JSON exactly with the recipe ids.`
      }
    ]
  };

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorMessage = await response.text();
      respond(res, response.status, { error: 'ChatGPT API error.', details: errorMessage });
      return;
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      respond(res, 502, { error: 'ChatGPT returned an empty response.' });
      return;
    }
    const cleaned = raw.replace(/```json|```/gi, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      respond(res, 502, { error: 'Unable to parse ChatGPT ranking response.' });
      return;
    }

    if (typeof parsed.primary !== 'string' || !Array.isArray(parsed.secondary)) {
      respond(res, 502, { error: 'ChatGPT returned unexpected data.' });
      return;
    }

    respond(res, 200, parsed);
  } catch (error) {
    respond(res, 500, { error: 'Unable to complete ranking request.', details: error.message });
  }
}

module.exports = handler;
