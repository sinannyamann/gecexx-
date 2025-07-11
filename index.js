import express from ‘express’;
import { createServer } from ‘http’;
import { WebSocketServer } from ‘ws’;
import pkg from ‘pg’;
const { Pool } = pkg;
import OpenAI from ‘openai’;
import axios from ‘axios’;
import cors from ‘cors’;
import helmet from ‘helmet’;
import rateLimit from ‘express-rate-limit’;
import compression from ‘compression’;
import winston from ‘winston’;
import NodeCache from ‘node-cache’;
import cron from ‘node-cron’;
import { fileURLToPath } from ‘url’;
import { dirname, join } from ‘path’;
import fs from ‘fs/promises’;
import multer from ‘multer’;
import mammoth from ‘mammoth’;
import sharp from ‘sharp’;
import session from ‘express-session’;
import connectPgSimple from ‘connect-pg-simple’;
import crypto from ‘crypto’;
import swaggerUi from ‘swagger-ui-express’;
import swaggerJsdoc from ‘swagger-jsdoc’;
import { pipeline } from ‘@xenova/transformers’;
import dotenv from ‘dotenv’;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Railway-optimized configuration
const config = {
port: process.env.PORT || 3000,
host: ‘0.0.0.0’,
cacheTTL: 1800, // 30 minutes
maxConversations: 10000,
maxMessagesPerConversation: 50,
dbMaxConnections: 20,
rateLimitMax: 1000,
maxFileSize: 50 * 1024 * 1024, // 50MB
allowedOrigins: process.env.ALLOWED_ORIGINS?.split(’,’) || [’*’],
maxTokens: 4000,
defaultModel: ‘gpt-4o-mini’
};

// Enhanced Logger with Railway compatibility
const logger = winston.createLogger({
level: process.env.LOG_LEVEL || ‘info’,
format: winston.format.combine(
winston.format.timestamp(),
winston.format.errors({ stack: true }),
winston.format.printf(({ timestamp, level, message, …meta }) => {
return `${timestamp} [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`;
})
),
defaultMeta: { service: ‘agi-agent’ },
transports: [
new winston.transports.Console({
format: winston.format.combine(
winston.format.colorize(),
winston.format.simple()
)
})
]
});

// Enhanced Cache with memory management
const cache = new NodeCache({
stdTTL: config.cacheTTL,
checkperiod: 120,
useClones: false,
maxKeys: 50000
});

// Database connection with Railway PostgreSQL
let pool = null;
let dbConnected = false;

async function initializeDatabase() {
if (!process.env.DATABASE_URL) {
logger.warn(‘💾 Database: Not configured - using in-memory storage’);
return false;
}

const maxRetries = 5;
let retryCount = 0;

while (retryCount < maxRetries) {
try {
pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: process.env.NODE_ENV === ‘production’ ? { rejectUnauthorized: false } : false,
max: config.dbMaxConnections,
idleTimeoutMillis: 30000,
connectionTimeoutMillis: 10000,
acquireTimeoutMillis: 60000,
createTimeoutMillis: 30000,
destroyTimeoutMillis: 5000,
reapIntervalMillis: 1000,
createRetryIntervalMillis: 200,
});

```
  // Test connection
  const client = await pool.connect();
  await client.query('SELECT NOW()');
  client.release();

  // Create enhanced tables with better indexing
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON user_sessions(expire);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_logs (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      response TEXT NOT NULL,
      provider VARCHAR(50),
      model VARCHAR(100),
      tone VARCHAR(50),
      tokens_used INTEGER DEFAULT 0,
      response_time INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS IDX_chat_session_created ON chat_logs(session_id, created_at);
    CREATE INDEX IF NOT EXISTS IDX_chat_provider_model ON chat_logs(provider, model);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255),
      message_id INTEGER REFERENCES chat_logs(id),
      rating INTEGER CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS IDX_feedback_rating ON feedback(rating);
  `);

  // AGI-specific tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255),
      memory_type VARCHAR(50),
      content JSONB,
      importance_score FLOAT DEFAULT 0.5,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS IDX_memory_session_type ON agent_memory(session_id, memory_type);
    CREATE INDEX IF NOT EXISTS IDX_memory_importance ON agent_memory(importance_score DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(255),
      task_type VARCHAR(100),
      status VARCHAR(50) DEFAULT 'pending',
      input_data JSONB,
      output_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS IDX_tasks_status ON agent_tasks(status);
  `);

  logger.info('💾 Database initialized successfully');
  dbConnected = true;
  return true;
} catch (error) {
  retryCount++;
  logger.error(`Database initialization failed (attempt ${retryCount}/${maxRetries})`, { 
    error: error.message 
  });
  
  if (retryCount < maxRetries) {
    await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
  }
}
```

}

logger.error(‘Failed to initialize database after maximum retries’);
return false;
}

// Enhanced AI Providers with more options
const aiProviders = {
openai: process.env.OPENAI_API_KEY ? new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
timeout: 60000,
maxRetries: 3
}) : null,

deepseek: process.env.DEEPSEEK_API_KEY ? {
apiKey: process.env.DEEPSEEK_API_KEY,
baseURL: ‘https://api.deepseek.com/v1’
} : null,

anthropic: process.env.ANTHROPIC_API_KEY ? {
apiKey: process.env.ANTHROPIC_API_KEY,
baseURL: ‘https://api.anthropic.com/v1’
} : null,

groq: process.env.GROQ_API_KEY ? {
apiKey: process.env.GROQ_API_KEY,
baseURL: ‘https://api.groq.com/openai/v1’
} : null,

ollama: process.env.OLLAMA_URL ? {
baseURL: process.env.OLLAMA_URL
} : null
};

// Enhanced Memory Manager with AGI capabilities
class EnhancedMemoryManager {
constructor() {
this.conversations = new Map();
this.episodicMemory = new Map(); // Long-term memory
this.semanticMemory = new Map(); // Knowledge base
this.proceduralMemory = new Map(); // Skills and procedures
this.workingMemory = new Map(); // Current context
this.maxConversations = config.maxConversations;
this.maxMessagesPerConversation = config.maxMessagesPerConversation;
}

addMessage(sessionId, message) {
if (!this.conversations.has(sessionId)) {
this.conversations.set(sessionId, []);
}

```
const conversation = this.conversations.get(sessionId);
const enhancedMessage = {
  ...message,
  timestamp: new Date().toISOString(),
  id: crypto.randomUUID(),
  importance: this.calculateImportance(message)
};

conversation.push(enhancedMessage);

// Maintain conversation size
if (conversation.length > this.maxMessagesPerConversation) {
  const removed = conversation.splice(0, conversation.length - this.maxMessagesPerConversation);
  this.archiveToEpisodicMemory(sessionId, removed);
}

// Update working memory
this.updateWorkingMemory(sessionId, enhancedMessage);

// Cleanup old conversations
if (this.conversations.size > this.maxConversations) {
  const oldestKey = this.conversations.keys().next().value;
  this.archiveConversation(oldestKey);
  this.conversations.delete(oldestKey);
}
```

}

calculateImportance(message) {
// Simple importance scoring based on content analysis
const content = message.content?.toLowerCase() || ‘’;
let score = 0.5;

```
// Boost for questions
if (content.includes('?')) score += 0.2;

// Boost for emotional content
const emotionalWords = ['love', 'hate', 'amazing', 'terrible', 'excited', 'worried'];
if (emotionalWords.some(word => content.includes(word))) score += 0.3;

// Boost for technical content
const technicalWords = ['code', 'algorithm', 'function', 'api', 'database'];
if (technicalWords.some(word => content.includes(word))) score += 0.2;

return Math.min(1.0, score);
```

}

updateWorkingMemory(sessionId, message) {
if (!this.workingMemory.has(sessionId)) {
this.workingMemory.set(sessionId, {
currentTopic: null,
recentEntities: [],
contextSummary: ‘’,
lastUpdate: new Date()
});
}

```
const workingMem = this.workingMemory.get(sessionId);
workingMem.lastUpdate = new Date();

// Extract entities (simple implementation)
const entities = this.extractEntities(message.content);
workingMem.recentEntities = [...new Set([...workingMem.recentEntities, ...entities])].slice(-10);
```

}

extractEntities(text) {
// Simple entity extraction (in production, use NER models)
const entities = [];
const words = text.split(/\s+/);

```
for (const word of words) {
  if (word.length > 3 && /^[A-Z]/.test(word)) {
    entities.push(word);
  }
}

return entities;
```

}

archiveToEpisodicMemory(sessionId, messages) {
if (!this.episodicMemory.has(sessionId)) {
this.episodicMemory.set(sessionId, []);
}

```
const episodic = this.episodicMemory.get(sessionId);
episodic.push(...messages.filter(msg => msg.importance > 0.7));

// Keep only most important memories
this.episodicMemory.set(sessionId, episodic.slice(-100));
```

}

archiveConversation(sessionId) {
const conversation = this.conversations.get(sessionId);
if (conversation) {
this.archiveToEpisodicMemory(sessionId, conversation);
}
}

getRelevantMemory(sessionId, query) {
const memories = {
recent: this.conversations.get(sessionId) || [],
episodic: this.episodicMemory.get(sessionId) || [],
working: this.workingMemory.get(sessionId) || {},
semantic: this.getSemanticMemory(query)
};

```
return memories;
```

}

getSemanticMemory(query) {
// Simple semantic search (in production, use vector embeddings)
const queryLower = query.toLowerCase();
const relevantFacts = [];

```
for (const [key, value] of this.semanticMemory) {
  if (key.toLowerCase().includes(queryLower) || 
      queryLower.includes(key.toLowerCase())) {
    relevantFacts.push(value);
  }
}

return relevantFacts;
```

}

addSemanticMemory(concept, information) {
this.semanticMemory.set(concept, {
information,
timestamp: new Date(),
accessCount: 0
});
}

getConversation(sessionId) {
return this.conversations.get(sessionId) || [];
}

clearConversation(sessionId) {
this.conversations.delete(sessionId);
this.episodicMemory.delete(sessionId);
this.workingMemory.delete(sessionId);
}

getStats() {
return {
totalConversations: this.conversations.size,
totalMessages: Array.from(this.conversations.values()).reduce((sum, conv) => sum + conv.length, 0),
episodicMemorySize: this.episodicMemory.size,
semanticMemorySize: this.semanticMemory.size,
workingMemorySize: this.workingMemory.size
};
}
}

// Local AI Models
let sentimentPipeline = null;
let classificationPipeline = null;
let questionAnsweringPipeline = null;

async function initializeLocalModels() {
try {
logger.info(‘🤖 Initializing local AI models…’);

```
// Initialize sentiment analysis
sentimentPipeline = await pipeline(
  'sentiment-analysis',
  'distilbert-base-uncased-finetuned-sst-2-english',
  { cache_dir: './model_cache' }
);

// Initialize text classification
classificationPipeline = await pipeline(
  'zero-shot-classification',
  'facebook/bart-large-mnli',
  { cache_dir: './model_cache' }
);

logger.info('🤖 Local models initialized successfully');
```

} catch (error) {
logger.error(‘❌ Local model initialization failed’, { error: error.message });
}
}

// Enhanced AGI Agent Class
class AGIAgent {
constructor() {
this.memoryManager = new EnhancedMemoryManager();
this.requestCount = 0;
this.errorCount = 0;
this.successCount = 0;
this.startTime = Date.now();
this.skills = new Map();
this.learningEnabled = true;

```
// Dynamic provider weights with learning
this.providerWeights = {
  openai: 1.0,
  deepseek: 0.8,
  anthropic: 0.9,
  groq: 0.7,
  ollama: 0.6
};

// Performance tracking
this.providerPerformance = {
  openai: { successes: 0, failures: 0, avgResponseTime: 0 },
  deepseek: { successes: 0, failures: 0, avgResponseTime: 0 },
  anthropic: { successes: 0, failures: 0, avgResponseTime: 0 },
  groq: { successes: 0, failures: 0, avgResponseTime: 0 },
  ollama: { successes: 0, failures: 0, avgResponseTime: 0 }
};

this.initializeSkills();
```

}

initializeSkills() {
// Register built-in skills
this.registerSkill(‘code_generation’, this.generateCode.bind(this));
this.registerSkill(‘data_analysis’, this.analyzeData.bind(this));
this.registerSkill(‘problem_solving’, this.solveProblem.bind(this));
this.registerSkill(‘creative_writing’, this.createContent.bind(this));
this.registerSkill(‘research’, this.conductResearch.bind(this));
this.registerSkill(‘math_calculation’, this.calculateMath.bind(this));
this.registerSkill(‘translation’, this.translateText.bind(this));
this.registerSkill(‘summarization’, this.summarizeText.bind(this));
}

registerSkill(name, skillFunction) {
this.skills.set(name, {
function: skillFunction,
usageCount: 0,
successRate: 0,
lastUsed: null
});
}

async callGroq(messages, options = {}) {
if (!aiProviders.groq) {
throw new Error(‘Groq not configured’);
}

```
const response = await axios.post(
  `${aiProviders.groq.baseURL}/chat/completions`,
  {
    model: options.model || 'mixtral-8x7b-32768',
    messages,
    max_tokens: options.maxTokens || config.maxTokens,
    temperature: options.temperature || 0.7,
    stream: false
  },
  {
    headers: {
      'Authorization': `Bearer ${aiProviders.groq.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  }
);

return {
  content: response.data.choices[0].message.content,
  usage: response.data.usage,
  model: response.data.model,
  provider: 'groq'
};
```

}

async callOllama(messages, options = {}) {
if (!aiProviders.ollama) {
throw new Error(‘Ollama not configured’);
}

```
const response = await axios.post(
  `${aiProviders.ollama.baseURL}/api/chat`,
  {
    model: options.model || 'llama2',
    messages,
    stream: false
  },
  {
    timeout: 120000
  }
);

return {
  content: response.data.message.content,
  usage: null,
  model: response.data.model,
  provider: 'ollama'
};
```

}

async analyzeIntent(message) {
try {
if (classificationPipeline) {
const labels = [
‘question’, ‘request’, ‘complaint’, ‘compliment’,
‘technical_help’, ‘creative_task’, ‘analysis’, ‘general_chat’
];

```
    const result = await classificationPipeline(message, labels);
    return {
      intent: result.labels[0],
      confidence: result.scores[0]
    };
  }
} catch (error) {
  logger.warn('Intent analysis failed', { error: error.message });
}

return { intent: 'general_chat', confidence: 0.5 };
```

}

async analyzeSentiment(text) {
try {
if (sentimentPipeline) {
const result = await sentimentPipeline(text);
return {
label: result[0].label.toLowerCase(),
score: result[0].score,
source: ‘local’
};
}
} catch (error) {
logger.warn(‘Local sentiment analysis failed’, { error: error.message });
}

```
// Fallback to API-based sentiment analysis
try {
  if (aiProviders.openai) {
    const response = await aiProviders.openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'Analyze the sentiment of the following text. Respond with JSON: {"label": "positive|negative|neutral", "score": 0.0-1.0, "reasoning": "brief explanation"}'
        },
        { role: 'user', content: text }
      ],
      max_tokens: 100,
      temperature: 0.1
    });
    
    const result = JSON.parse(response.choices[0].message.content);
    return { ...result, source: 'api' };
  }
} catch (error) {
  logger.warn('API sentiment analysis failed', { error: error.message });
}

return { label: 'neutral', score: 0.5, source: 'fallback' };
```

}

async processMessage(sessionId, message, options = {}) {
const startTime = Date.now();

```
try {
  // Get relevant memory
  const memory = this.memoryManager.getRelevantMemory(sessionId, message);
  
  // Analyze intent and sentiment
  const [intent, sentiment] = await Promise.all([
    this.analyzeIntent(message),
    this.analyzeSentiment(message)
  ]);
  
  // Identify required skills
  const requiredSkills = await this.identifyRequiredSkills(message);
  
  // Build context
  const context = {
    message,
    sessionId,
    memory,
    intent,
    sentiment,
    requiredSkills,
    options
  };
  
  // Execute appropriate skills
  let response;
  if (requiredSkills.length === 1 && requiredSkills[0] !== 'general_conversation') {
    // Single skill execution
    const skillResult = await this.executeSkill(requiredSkills[0], context);
    response = skillResult.success ? skillResult.result : await this.handleGeneralConversation(context);
  } else if (requiredSkills.length > 1) {
    // Multi-skill execution
    response = await this.executeMultipleSkills(requiredSkills, context);
  } else {
    // General conversation
    response = await this.handleGeneralConversation(context);
  }
  
  // Add to memory
  this.memoryManager.addMessage(sessionId, { role: 'user', content: message });
  this.memoryManager.addMessage(sessionId, { 
    role: 'assistant', 
    content: response.content,
    provider: response.provider,
    model: response.model,
    intent,
    sentiment,
    skills: requiredSkills,
    processingTime: Date.now() - startTime
  });
  
  return {
    ...response,
    intent,
    sentiment,
    skills: requiredSkills,
    processingTime: Date.now() - startTime
  };
  
} catch (error) {
  logger.error('Message processing failed', { 
    error: error.message, 
    sessionId, 
    message: message.substring(0, 100) 
  });
  
  return {
    content: "I apologize, but I encountered an error processing your request. Please try again.",
    provider: 'fallback',
    model: 'error-handler',
    error: error.message
  };
}
```

}

async handleGeneralConversation(context) {
const { message, memory, intent, sentiment } = context;

```
// Build conversation history
const conversationHistory = [
  {
    role: 'system',
    content: `You are an advanced AGI assistant with the following capabilities:
    - Deep understanding and reasoning
    - Creative problem solving
    - Technical expertise across multiple domains
    - Emotional intelligence and empathy
    - Continuous learning and adaptation
    
    Current conversation context:
    - User intent: ${intent.intent} (confidence: ${intent.confidence})
    - Sentiment: ${sentiment.label} (score: ${sentiment.score})
    - Recent entities: ${memory.working.recentEntities?.join(', ') || 'None'}
    
    Respond in a way that demonstrates understanding, provides value, and encourages further interaction.`
  }
];

// Add recent conversation history
if (memory.recent.length > 0) {
  conversationHistory.push(...memory.recent.slice(-5));
}

// Add current message
conversationHistory.push({ role: 'user', content: message });

// Select best provider based on intent
const providers = this.selectProvidersForIntent(intent.intent);

return await this.callAI(providers, conversationHistory, {
  temperature: sentiment.label === 'positive' ? 0.8 : 0.7,
  maxTokens: config.maxTokens
});
```

}

async executeMultipleSkills(skills, context) {
const results = [];

```
for (const skill of skills) {
  try {
    const result = await this.executeSkill(skill, context);
    results.push(result);
  } catch (error) {
    logger.warn(`Skill ${skill} execution failed`, { error: error.message });
  }
}

// Combine results
const successfulResults = results.filter(r => r.success);

if (successfulResults.length === 0) {
  return await this.handleGeneralConversation(context);
}

// Synthesize multiple skill results
const combinedContent = successfulResults.map(r => r.result.content).join('\n\n');

return {
  content: combinedContent,
  provider: 'multi-skill',
  model: 'skill-synthesis',
  skills: skills,
  results: successfulResults
};
```

}

selectProvidersForIntent(intent) {
const intentProviderMap = {
‘technical_help’: [‘openai’, ‘deepseek’, ‘groq’],
‘creative_task’: [‘openai’, ‘anthropic’],
‘analysis’: [‘openai’, ‘anthropic’],
‘question’: [‘openai’, ‘deepseek’, ‘anthropic’],
‘general_chat’: [‘openai’, ‘anthropic’, ‘groq’]
};

```
return intentProviderMap[intent] || ['openai', 'anthropic'];
```

}

async processFeedback(sessionId, messageId, rating, comment) {
if (!pool || !dbConnected) {
logger.warn(‘Database not available for feedback processing’);
return;
}

```
try {
  // Get the message details
  const messageQuery = 'SELECT provider, model FROM chat_logs WHERE id = $1';
  const messageResult = await pool.query(messageQuery, [messageId]);
  
  if (messageResult.rowCount === 0) {
    logger.warn('Message not found for feedback', { messageId });
    return;
  }
  
  const { provider, model } = messageResult.rows[0];
  
  // Save feedback
  await pool.query(
    'INSERT INTO feedback (session_id, message_id, rating, comment) VALUES ($1, $2, $3, $4)',
    [sessionId, messageId, rating, comment]
  );
  
  // Update provider weights based on feedback
  if (rating >= 4) {
    this.providerWeights[provider] = Math.min(2.0, this.providerWeights[provider] + 0.1);
  } else if (rating <= 2) {
    this.providerWeights[provider] = Math.max(0.1, this.providerWeights[provider] - 0.2);
  }
  
  // Learn from feedback
  if (this.learningEnabled) {
    await this.learnFromFeedback(sessionId, messageId, rating, comment, provider, model);
  }
  
  logger.info('Feedback processed successfully', { 
    sessionId, messageId, rating, provider 
  });
  
} catch (error) {
  logger.error('Feedback processing failed', { 
    error: error.message, 
    sessionId, 
    messageId 
  });
}
```

}

async learnFromFeedback(sessionId, messageId, rating, comment, provider, model) {
// Store learning data
const learningData = {
messageId,
rating,
comment,
provider,
model,
timestamp: new Date(),
sessionId
};

```
// Add to semantic memory if high rating
if (rating >= 4 && comment) {
  this.memoryManager.addSemanticMemory(
    `positive_feedback_${Date.now()}`,
    {
      type: 'feedback',
      rating,
      comment,
      provider,
      model,
      learningPoints: this.extractLearningPoints(comment)
    }
  );
}

// Adjust model selection strategy
if (rating <= 2) {
  // Temporarily reduce preference for this provider for similar queries
  this.providerWeights[provider] *= 0.9;
}

logger.info('Learning from feedback completed', { 
  sessionId, messageId, rating, provider 
});
```

}

extractLearningPoints(comment) {
// Simple keyword extraction for learning
const positiveKeywords = [‘good’, ‘great’, ‘helpful’, ‘accurate’, ‘clear’, ‘useful’];
const negativeKeywords = [‘bad’, ‘wrong’, ‘unclear’, ‘unhelpful’, ‘confusing’];

```
const lowerComment = comment.toLowerCase();
const learningPoints = {
  positive: positiveKeywords.filter(keyword => lowerComment.includes(keyword)),
  negative: negativeKeywords.filter(keyword => lowerComment.includes(keyword)),
  suggestions: lowerComment.includes('suggest') || lowerComment.includes('should') ? [comment] : []
};

return learningPoints;
```

}

getDetailedStats() {
const baseStats = {
requests: {
total: this.requestCount,
successful: this.successCount,
failed: this.errorCount,
successRate: this.requestCount > 0 ? (this.successCount / this.requestCount) * 100 : 0
},
uptime: {
milliseconds: Date.now() - this.startTime,
hours: Math.floor((Date.now() - this.startTime) / (1000 * 60 * 60)),
days: Math.floor((Date.now() - this.startTime) / (1000 * 60 * 60 * 24))
},
memory: this.memoryManager.getStats(),
cache: cache.getStats(),
providers: {
weights: this.providerWeights,
performance: this.providerPerformance
},
skills: Object.fromEntries(
Array.from(this.skills.entries()).map(([name, skill]) => [
name,
{
usageCount: skill.usageCount,
successRate: skill.successRate,
lastUsed: skill.lastUsed
}
])
)
};

```
return baseStats;
```

}
}

// Initialize AGI Agent
const agiAgent = new AGIAgent();

// Express Application Setup
const app = express();
const server = createServer(app);

// Session configuration
const sessionConfig = {
secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString(‘hex’),
resave: false,
saveUninitialized: false,
cookie: {
secure: process.env.NODE_ENV === ‘production’,
httpOnly: true,
maxAge: 24 * 60 * 60 * 1000,
sameSite: ‘lax’
}
};

async function setupSessionStore() {
if (pool && dbConnected) {
const PgSession = connectPgSimple(session);
sessionConfig.store = new PgSession({
pool,
tableName: ‘user_sessions’,
createTableIfMissing: true
});
logger.info(‘💾 Session store configured with PostgreSQL’);
} else {
logger.warn(‘💾 Using memory session store (not recommended for production)’);
}
}

// Swagger configuration
const swaggerOptions = {
definition: {
openapi: ‘3.0.0’,
info: {
title: ‘AGI Agent API’,
version: ‘2.0.0’,
description: ‘Advanced AGI Agent with multi-modal capabilities, learning, and skill execution’,
contact: {
name: ‘AGI Agent’,
url: ‘https://github.com/yourusername/agi-agent’
}
},
servers: [
{
url: process.env.NODE_ENV === ‘production’
? ‘https://your-app.railway.app’
: `http://localhost:${config.port}`,
description: process.env.NODE_ENV === ‘production’ ? ‘Production’ : ‘Development’
}
]
},
apis: [’./index.js’]
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Middleware setup
app.set(‘trust proxy’, 1);
app.use(session(sessionConfig));
app.use(helmet({
crossOriginEmbedderPolicy: false,
contentSecurityPolicy: {
directives: {
defaultSrc: [”‘self’”],
styleSrc: [”‘self’”, “‘unsafe-inline’”, “https://fonts.googleapis.com”],
fontSrc: [”‘self’”, “https://fonts.gstatic.com”],
scriptSrc: [”‘self’”, “‘unsafe-inline’”],
imgSrc: [”‘self’”, “data:”, “https:”],
connectSrc: [”‘self’”, “ws:”, “wss:”]
}
}
}));

app.use(rateLimit({
windowMs: 15 * 60 * 1000, // 15 minutes
max: config.rateLimitMax,
message: ‘Too many requests from this IP, please try again later.’,
standardHeaders: true,
legacyHeaders: false,
skip: (req) => {
// Skip rate limiting for health checks
return req.path === ‘/health’ || req.path === ‘/’;
}
}));

app.use(cors({
origin: (origin, callback) => {
if (!origin) return callback(null, true);

```
if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) {
  return callback(null, true);
}

return callback(new Error('Not allowed by CORS'));
```

},
credentials: true,
methods: [‘GET’, ‘POST’, ‘PUT’, ‘DELETE’, ‘OPTIONS’],
allowedHeaders: [‘Content-Type’, ‘Authorization’, ‘X-Requested-With’]
}));

app.use(compression());
app.use(express.json({ limit: ‘10mb’ }));
app.use(express.urlencoded({ extended: true, limit: ‘10mb’ }));

// File upload configuration
const upload = multer({
dest: ‘uploads/’,
limits: {
fileSize: config.maxFileSize,
files: 5
},
fileFilter: (req, file, cb) => {
const allowedTypes = [
‘image/jpeg’, ‘image/png’, ‘image/gif’, ‘image/webp’,
‘application/pdf’,
‘application/vnd.openxmlformats-officedocument.wordprocessingml.document’,
‘application/vnd.openxmlformats-officedocument.spreadsheetml.sheet’,
‘text/plain’, ‘text/csv’,
‘application/json’
];

```
if (allowedTypes.includes(file.mimetype)) {
  cb(null, true);
} else {
  cb(new Error(`File type ${file.mimetype} not allowed`));
}
```

}
});

// Serve static files
app.use(express.static(join(__dirname, ‘public’)));

// API Documentation
app.use(’/api-docs’, swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check endpoint
app.get([’/’, ‘/health’], (req, res) => {
res.status(200).json({
status: ‘healthy’,
service: ‘agi-agent’,
version: ‘2.0.0’,
timestamp: new Date().toISOString(),
uptime: process.uptime(),
memory: process.memoryUsage(),
database: dbConnected ? ‘connected’ : ‘disconnected’,
environment: process.env.NODE_ENV || ‘development’
});
});

// Main chat endpoint
app.post(’/api/chat’, async (req, res) => {
try {
const { message, provider = ‘auto’, options = {} } = req.body;

```
// Validation
if (!message || typeof message !== 'string') {
  return res.status(400).json({ 
    error: 'Message is required and must be a string' 
  });
}

if (message.length > 10000) {
  return res.status(400).json({ 
    error: 'Message too long (max 10000 characters)' 
  });
}

// Get or create session
const sessionId = req.session.id || crypto.randomUUID();
if (!req.session.id) {
  req.session.id = sessionId;
}

// Process message with AGI agent
const response = await agiAgent.processMessage(sessionId, message, { 
  provider, 
  ...options 
});

// Log to database if available
if (pool && dbConnected) {
  try {
    const logResult = await pool.query(
      `INSERT INTO chat_logs (session_id, message, response, provider, model, tone, tokens_used, response_time) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        sessionId,
        message,
        response.content,
        response.provider,
        response.model,
        response.sentiment?.label || 'neutral',
        response.usage?.total_tokens || 0,
        response.processingTime || 0
      ]
    );
    
    response.messageId = logResult.rows[0].id;
  } catch (dbError) {
    logger.warn('Failed to log chat to database', { 
      error: dbError.message,
      sessionId 
    });
  }
}

res.json({
  response: response.content,
  provider: response.provider,
  model: response.model,
  intent: response.intent,
  sentiment: response.sentiment,
  skills: response.skills,
  processingTime: response.processingTime,
  usage: response.usage,
  messageId: response.messageId || null
});
```

} catch (error) {
logger.error(‘Chat API error’, {
error: error.message,
stack: error.stack,
body: req.body
});

```
res.status(500).json({
  error: 'An error occurred while processing your request',
  details: process.env.NODE_ENV === 'development' ? error.message : undefined
});
```

}
});

// Feedback endpoint
app.post(’/api/feedback’, async (req, res) => {
try {
const { messageId, rating, comment } = req.body;
const sessionId = req.session.id;

```
// Validation
if (!messageId || !rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
  return res.status(400).json({ 
    error: 'Valid messageId and rating (1-5) are required' 
  });
}

await agiAgent.processFeedback(sessionId, messageId, rating, comment);

res.json({ 
  success: true,
  message: 'Feedback submitted successfully'
});
```

} catch (error) {
logger.error(‘Feedback API error’, {
error: error.message,
body: req.body
});

```
res.status(500).json({ 
  error: 'Failed to submit feedback',
  details: process.env.NODE_ENV === 'development' ? error.message : undefined
});
```

}
});

// File upload endpoint
app.post(’/api/upload’, upload.single(‘file’), async (req, res) => {
try {
if (!req.file) {
return res.status(400).json({
error: ‘No file uploaded’
});
}

```
const processingType = req.body.processingType || 'extract_text';

const fileInfo = {
  id: crypto.randomUUID(),
  filename: req.file.filename,
  originalName: req.file.originalname,
  mimetype: req.file.mimetype,
  size: req.file.size,
  path: req.file.path,
  uploadTime: new Date().toISOString()
};

let processedContent = '';
let processingError = null;

try {
  if (req.file.mimetype.startsWith('image/')) {
    const metadata = await sharp(req.file.path).metadata();
    processedContent = `Image uploaded: ${metadata.width}x${metadata.height} pixels, ${metadata.format} format, ${Math.round(req.file.size / 1024)}KB`;
    
    if (processingType === 'analyze_image') {
      // Use AI to analyze the image
      const analysisPrompt = `Analyze this image and provide a detailed description of what you see.`;
      const analysisResponse = await agiAgent.callAI(['openai'], [
        { role: 'system', content: 'You are an expert image analyst. Provide detailed, accurate descriptions.' },
        { role: 'user', content: analysisPrompt }
      ]);
      processedContent += `\n\nAI Analysis: ${analysisResponse.content}`;
    }
    
  } else if (req.file.mimetype.includes('document') || req.file.mimetype.includes('word')) {
    const result = await mammoth.extractRawText({ path: req.file.path });
    processedContent = result.value;
    
    if (processingType === 'summarize' && processedContent.length > 500) {
      const summaryResponse = await agiAgent.callAI(['openai'], [
        { role: 'system', content: 'You are a professional summarizer. Create concise, informative summaries.' },
        { role: 'user', content: `Summarize this document:\n\n${processedContent.substring(0, 3000)}` }
      ]);
      processedContent = `Summary: ${summaryResponse.content}\n\n--- Original Text ---\n${processedContent}`;
    }
    
  } else if (req.file.mimetype === 'text/plain') {
    processedContent = await fs.readFile(req.file.path, 'utf8');
    
  } else if (req.file.mimetype === 'application/json') {
    const jsonContent = await fs.readFile(req.file.path, 'utf8');
    const parsed = JSON.parse(jsonContent);
    processedContent = JSON.stringify(parsed, null, 2);
    
  } else {
    processedContent = `File uploaded: ${req.file.originalname} (${req.file.mimetype})`;
  }
} catch (processError) {
  processingError = processError.message;
  processedContent = `File uploaded but processing failed: ${processError.message}`;
  logger.warn('File processing failed', { 
    error: processError.message,
    fileInfo 
  });
}

res.json({
  success: true,
  file: fileInfo,
  content: processedContent.substring(0, 5000), // Limit response size
  processingType,
  processingError
});
```

} catch (error) {
logger.error(‘File upload error’, {
error: error.message,
fileInfo: req.file ? {
originalName: req.file.originalname,
mimetype: req.file.mimetype,
size: req.file.size
} : null
});

```
res.status(500).json({ 
  error: 'File upload failed',
  details: process.env.NODE_ENV === 'development' ? error.message : undefined
});
```

}
});

// Statistics endpoint
app.get(’/api/stats’, (req, res) => {
try {
const stats = agiAgent.getDetailedStats();

```
// Add system information
stats.system = {
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  cpuUsage: process.cpuUsage()
};

res.json(stats);
```

} catch (error) {
logger.error(‘Stats API error’, { error: error.message });
res.status(500).json({
error: ‘Failed to retrieve statistics’
});
}
});

// WebSocket for real-time communication
const wss = new WebSocketServer({
server,
path: ‘/ws’,
clientTracking: true
});

// Store active connections
const activeConnections = new Map();

wss.on(‘connection’, (ws, req) => {
const sessionId = crypto.randomUUID();
const connectionInfo = {
sessionId,
connectedAt: new Date(),
lastActivity: new Date(),
messageCount: 0
};

activeConnections.set(sessionId, { ws, info: connectionInfo });

logger.info(‘WebSocket connection established’, {
sessionId,
totalConnections: activeConnections.size
});

// Send welcome message
ws.send(JSON.stringify({
type: ‘welcome’,
message: ‘Connected to AGI Agent’,
sessionId,
capabilities: Array.from(agiAgent.skills.keys()),
timestamp: new Date().toISOString()
}));

// Set up heartbeat
const heartbeat = setInterval(() => {
if (ws.readyState === ws.OPEN) {
ws.ping();

```
  // Check for inactive connections
  const lastActivity = connectionInfo.lastActivity;
  const inactiveTime = Date.now() - lastActivity.getTime();
  
  if (inactiveTime > 300000) { // 5 minutes
    logger.info('Closing inactive WebSocket connection', { sessionId });
    ws.close();
  }
}
```

}, 30000);

ws.on(‘message’, async (data) => {
try {
connectionInfo.lastActivity = new Date();
connectionInfo.messageCount++;

```
  const message = JSON.parse(data.toString());
  
  logger.debug('WebSocket message received', { 
    sessionId, 
    type: message.type,
    messageCount: connectionInfo.messageCount
  });

  switch (message.type) {
    case 'chat':
      await handleWebSocketChat(ws, sessionId, message);
      break;
      
    case 'execute_skill':
      await handleWebSocketSkill(ws, sessionId, message);
      break;
      
    case 'get_stats':
      ws.send(JSON.stringify({
        type: 'stats',
        data: agiAgent.getDetailedStats(),
        timestamp: new Date().toISOString()
      }));
      break;
      
    case 'ping':
      ws.send(JSON.stringify({
        type: 'pong',
        timestamp: new Date().toISOString()
      }));
      break;
      
    default:
      ws.send(JSON.stringify({
        type: 'error',
        message: `Unknown message type: ${message.type}`,
        timestamp: new Date().toISOString()
      }));
  }
  
} catch (error) {
  logger.error('WebSocket message processing error', { 
    sessionId,
    error: error.message,
    data: data.toString().substring(0, 200)
  });
  
  ws.send(JSON.stringify({
    type: 'error',
    message: 'Message processing failed',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    timestamp: new Date().toISOString()
  }));
}
```

});

ws.on(‘close’, () => {
clearInterval(heartbeat);
activeConnections.delete(sessionId);

```
logger.info('WebSocket connection close identifyRequiredSkills(message) {
const content = message.toLowerCase();
const requiredSkills = [];

// Pattern matching for skill identification
const skillPatterns = {
  code_generation: /(?:write|create|generate|code|program|function|script|algorithm)/,
  data_analysis: /(?:analyze|data|chart|graph|statistics|trend)/,
  problem_solving: /(?:solve|problem|issue|debug|fix|troubleshoot)/,
  creative_writing: /(?:write|story|poem|creative|narrative|fiction)/,
  research: /(?:research|find|search|information|learn about)/,
  math_calculation: /(?:calculate|math|equation|formula|solve)/,
  translation: /(?:translate|translation|language)/,
  summarization: /(?:summarize|summary|brief|overview)/
};

for (const [skill, pattern] of Object.entries(skillPatterns)) {
  if (pattern.test(content)) {
    requiredSkills.push(skill);
  }
}

return requiredSkills.length > 0 ? requiredSkills : ['general_conversation'];
```

}

async executeSkill(skillName, context) {
const skill = this.skills.get(skillName);
if (!skill) {
throw new Error(`Skill '${skillName}' not found`);
}

```
const startTime = Date.now();

try {
  const result = await skill.function(context);
  const executionTime = Date.now() - startTime;
  
  // Update skill statistics
  skill.usageCount++;
  skill.lastUsed = new Date();
  skill.successRate = ((skill.successRate * (skill.usageCount - 1)) + 1) / skill.usageCount;
  
  return {
    success: true,
    result,
    executionTime,
    skill: skillName
  };
} catch (error) {
  const executionTime = Date.now() - startTime;
  
  // Update failure rate
  skill.usageCount++;
  skill.successRate = (skill.successRate * (skill.usageCount - 1)) / skill.usageCount;
  
  return {
    success: false,
    error: error.message,
    executionTime,
    skill: skillName
  };
}
```

}

// Skill implementations
async generateCode(context) {
const { message, requirements } = context;
const prompt = `Generate clean, production-ready code for: ${message}\n\nRequirements: ${requirements || 'None specified'}`;

```
return await this.callAI(['openai', 'deepseek'], [
  { role: 'system', content: 'You are an expert programmer. Generate clean, well-documented, production-ready code.' },
  { role: 'user', content: prompt }
]);
```

}

async analyzeData(context) {
const { data, analysisType } = context;
const prompt = `Analyze the following data and provide insights:\n\nData: ${JSON.stringify(data)}\nAnalysis Type: ${analysisType}`;

```
return await this.callAI(['openai', 'anthropic'], [
  { role: 'system', content: 'You are a data scientist. Provide detailed analysis with actionable insights.' },
  { role: 'user', content: prompt }
]);
```

}

async solveProblem(context) {
const { problem, constraints } = context;
const prompt = `Solve this problem step by step:\n\nProblem: ${problem}\nConstraints: ${constraints || 'None specified'}`;

```
return await this.callAI(['openai', 'anthropic'], [
  { role: 'system', content: 'You are a problem-solving expert. Break down complex problems into manageable steps.' },
  { role: 'user', content: prompt }
]);
```

}

async createContent(context) {
const { type, topic, style } = context;
const prompt = `Create ${type} content about: ${topic}\nStyle: ${style || 'engaging and informative'}`;

```
return await this.callAI(['openai', 'anthropic'], [
  { role: 'system', content: 'You are a creative writer. Create engaging, original content.' },
  { role: 'user', content: prompt }
]);
```

}

async conductResearch(context) {
const { topic, depth } = context;
const prompt = `Research and provide comprehensive information about: ${topic}\nDepth: ${depth || 'moderate'}`;

```
return await this.callAI(['openai', 'anthropic'], [
  { role: 'system', content: 'You are a research assistant. Provide accurate, well-sourced information.' },
  { role: 'user', content: prompt }
]);
```

}

async calculateMath(context) {
const { expression, showSteps } = context;
const prompt = `Calculate: ${expression}\n${showSteps ? 'Show all steps' : 'Provide the result'}`;

```
return await this.callAI(['openai'], [
  { role: 'system', content: 'You are a mathematics expert. Provide accurate calculations with clear explanations.' },
  { role: 'user', content: prompt }
]);
```

}

async translateText(context) {
const { text, fromLang, toLang } = context;
const prompt = `Translate the following text from ${fromLang} to ${toLang}:\n\n${text}`;

```
return await this.callAI(['openai', 'deepseek'], [
  { role: 'system', content: 'You are a professional translator. Provide accurate, contextual translations.' },
  { role: 'user', content: prompt }
]);
```

}

async summarizeText(context) {
const { text, length } = context;
const prompt = `Summarize the following text in ${length || 'moderate'} length:\n\n${text}`;

```
return await this.callAI(['openai', 'anthropic'], [
  { role: 'system', content: 'You are a summarization expert. Create concise, informative summaries.' },
  { role: 'user', content: prompt }
]);
```

}

async callAI(providers, messages, options = {}) {
const providerList = Array.isArray(providers) ? providers : [providers];

```
// Filter available providers
const availableProviders = providerList.filter(p => {
  if (p === 'openai') return aiProviders.openai;
  if (p === 'deepseek') return aiProviders.deepseek;
  if (p === 'anthropic') return aiProviders.anthropic;
  if (p === 'groq') return aiProviders.groq;
  if (p === 'ollama') return aiProviders.ollama;
  return false;
});

if (availableProviders.length === 0) {
  throw new Error('No AI providers available');
}

// Sort by performance weights
const sortedProviders = availableProviders.sort((a, b) => {
  return this.providerWeights[b] - this.providerWeights[a];
});

// Create cache key
const cacheKey = `ai_${crypto.createHash('md5').update(JSON.stringify({ messages, options })).digest('hex')}`;

// Check cache
if (!options.skipCache) {
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }
}

let lastError;

for (const provider of sortedProviders) {
  const startTime = Date.now();
  
  try {
    let result;
    
    switch (provider) {
      case 'openai':
        result = await this.callOpenAI(messages, options);
        break;
      case 'deepseek':
        result = await this.callDeepSeek(messages, options);
        break;
      case 'anthropic':
        result = await this.callAnthropic(messages, options);
        break;
      case 'groq':
        result = await this.callGroq(messages, options);
        break;
      case 'ollama':
        result = await this.callOllama(messages, options);
        break;
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
    
    const responseTime = Date.now() - startTime;
    
    // Update performance metrics
    this.updateProviderPerformance(provider, true, responseTime);
    
    // Cache the result
    cache.set(cacheKey, result, options.cacheTTL || config.cacheTTL);
    
    this.requestCount++;
    this.successCount++;
    
    return result;
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    // Update performance metrics
    this.updateProviderPerformance(provider, false, responseTime);
    
    lastError = error;
    this.errorCount++;
    
    logger.warn(`Provider ${provider} failed, trying next...`, {
      error: error.message,
      responseTime
    });
  }
}

throw lastError || new Error('All providers failed');
```

}

updateProviderPerformance(provider, success, responseTime) {
if (!this.providerPerformance[provider]) {
this.providerPerformance[provider] = { successes: 0, failures: 0, avgResponseTime: 0 };
}

```
const perf = this.providerPerformance[provider];

if (success) {
  perf.successes++;
  perf.avgResponseTime = ((perf.avgResponseTime * (perf.successes - 1)) + responseTime) / perf.successes;
  
  // Increase weight for successful providers
  this.providerWeights[provider] = Math.min(2.0, this.providerWeights[provider] + 0.05);
} else {
  perf.failures++;
  
  // Decrease weight for failed providers
  this.providerWeights[provider] = Math.max(0.1, this.providerWeights[provider] - 0.1);
}

// Normalize weights
const totalWeight = Object.values(this.providerWeights).reduce((sum, weight) => sum + weight, 0);
for (const [key, weight] of Object.entries(this.providerWeights)) {
  this.providerWeights[key] = weight / totalWeight;
}
```

}

async callOpenAI(messages, options = {}) {
if (!aiProviders.openai) {
throw new Error(‘OpenAI not configured’);
}

```
const response = await aiProviders.openai.chat.completions.create({
  model: options.model || config.defaultModel,
  messages,
  max_tokens: options.maxTokens || config.maxTokens,
  temperature: options.temperature || 0.7,
  stream: options.stream || false,
  response_format: options.responseFormat || undefined
});

return {
  content: response.choices[0].message.content,
  usage: response.usage,
  model: response.model,
  provider: 'openai'
};
```

}

async callDeepSeek(messages, options = {}) {
if (!aiProviders.deepseek) {
throw new Error(‘DeepSeek not configured’);
}

```
const response = await axios.post(
  `${aiProviders.deepseek.baseURL}/chat/completions`,
  {
    model: options.model || 'deepseek-chat',
    messages,
    max_tokens: options.maxTokens || config.maxTokens,
    temperature: options.temperature || 0.7,
    stream: false
  },
  {
    headers: {
      'Authorization': `Bearer ${aiProviders.deepseek.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: 60000
  }
);

return {
  content: response.data.choices[0].message.content,
  usage: response.data.usage,
  model: response.data.model,
  provider: 'deepseek'
};
```

}

async callAnthropic(messages, options = {}) {
if (!aiProviders.anthropic) {
throw new Error(‘Anthropic not configured’);
}

```
const systemMessage = messages.find(m => m.role === 'system');
const userMessages = messages.filter(m => m.role !== 'system');

const response = await axios.post(
  `${aiProviders.anthropic.baseURL}/messages`,
  {
    model: options.model || 'claude-3-sonnet-20240229',
    max_tokens: options.maxTokens || config.maxTokens,
    temperature: options.temperature || 0.7,
    system: systemMessage?.content || 'You are a helpful AI assistant.',
    messages: userMessages
  },
  {
    headers: {
      'x-api-key': aiProviders.anthropic.apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    },
    timeout: 60000
  }
);

return {
  content: response.data.content[0].text,
  usage: response.data.usage,
  model: response.data.model,
  provider: 'anthropic'
};
```

}

async