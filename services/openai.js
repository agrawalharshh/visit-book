// services/openai.js — thin wrapper around OpenAI's chat completions API
const fetch = require('node-fetch');
const db = require('../db/init');

function getKey() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('openai_api_key');
  return row ? row.value : null;
}

function isConfigured() {
  return !!getKey();
}

async function chat(messages, { model = 'gpt-4o-mini', temperature = 0.4, maxTokens = 400 } = {}) {
  const key = getKey();
  if (!key) {
    return { success: false, error: 'OpenAI not configured. Go to Settings → AI Features and add your API key.' };
  }
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    });
    const data = await res.json();
    if (data.error) return { success: false, error: data.error.message };
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { success: true, text: (text || '').trim() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Whisper transcription for voice-to-text visit logging
async function transcribeAudio(buffer, filename, mimeType) {
  const key = getKey();
  if (!key) return { success: false, error: 'OpenAI not configured. Go to Settings → AI Features and add your API key.' };
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', buffer, { filename: filename || 'audio.webm', contentType: mimeType || 'audio/webm' });
    form.append('model', 'whisper-1');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, ...form.getHeaders() },
      body: form,
    });
    const data = await res.json();
    if (data.error) return { success: false, error: data.error.message };
    return { success: true, text: (data.text || '').trim() };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { chat, transcribeAudio, isConfigured, getKey };
