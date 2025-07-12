import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pkg from 'pg';
const { Pool } = pkg;
import OpenAI from 'openai';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import winston from 'winston';
import NodeCache from 'node-cache';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import session from 'express-session';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const config = {
  port: process.env.PORT || 3000,
  host: '0.0.0.0',
  maxTokens: 4000,
  defaultModel: 'gpt-4o-mini'
};

// Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Cache
const cache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });

// Database
let pool = null;
let dbConnected = false;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    logger.warn('Database not configured');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10
    });

    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    // Create simple tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_logs (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        message TEXT,
        response TEXT,
        provider VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS feedback (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        message_id INTEGER,
        rating INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info('Database initialized');
    dbConnected = true;
    return true;
  } catch (error) {
    logger.error('Database failed:', error.message);
    return false;
  }
}

// AI Providers
const aiProviders = {
  openai: process.env.OPENAI_API_KEY ? new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000
  }) : null,
  
  deepseek: process.env.DEEPSEEK_API_KEY ? {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
  } : null,
  
  anthropic: process.env.ANTHROPIC_API_KEY ? {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com/v1'
  } : null
};

// Simple Memory Manager
class SimpleMemoryManager {
  constructor() {
    this.conversations = new Map();
    this.maxConversations = 1000;
    this.maxMessages = 20;
  }

  addMessage(sessionId, message) {
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }
    
    const conversation = this.conversations.get(sessionId);
    conversation.push({
      ...message,
      timestamp: new Date().toISOString()
    });
    
    if (conversation.length > this.maxMessages) {
      conversation.splice(0, conversation.length - this.maxMessages);
    }
    
    if (this.conversations.size > this.maxConversations) {
      const oldestKey = this.conversations.keys().next().value;
      this.conversations.delete(oldestKey);
    }
  }

  getConversation(sessionId) {
    return this.conversations.get(sessionId) || [];
  }

  getStats() {
    return {
      totalConversations: this.conversations.size,
      totalMessages: Array.from(this.conversations.values()).reduce((sum, conv) => sum + conv.length, 0)
    };
  }
}

// Simple AGI Agent
class SimpleAGIAgent {
  constructor() {
    this.memoryManager = new SimpleMemoryManager();
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    
    this.providerWeights = {
      openai: 1.0,
      deepseek: 0.8,
      anthropic: 0.9
    };
  }

  async callAI(providers, messages, options = {}) {
    const providerList = Array.isArray(providers) ? providers : [providers];
    const availableProviders = providerList.filter(p => aiProviders[p]);

    if (availableProviders.length === 0) {
      throw new Error('No AI providers available');
    }

    const cacheKey = `ai_${crypto.createHash('md5').update(JSON.stringify(messages)).digest('hex')}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    for (const provider of availableProviders) {
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
        }
        
        cache.set(cacheKey, result);
        this.requestCount++;
        return result;
        
      } catch (error) {
        this.errorCount++;
        logger.warn(`Provider ${provider} failed:`, error.message);
      }
    }
    
    throw new Error('All providers failed');
  }

  async callOpenAI(messages, options = {}) {
    if (!aiProviders.openai) throw new Error('OpenAI not configured');
    
    const response = await aiProviders.openai.chat.completions.create({
      model: options.model || config.defaultModel,
      messages,
      max_tokens: options.maxTokens || config.maxTokens,
      temperature: options.temperature || 0.7
    });
    
    return {
      content: response.choices[0].message.content,
      usage: response.usage,
      model: response.model,
      provider: 'openai'
    };
  }

  async callDeepSeek(messages, options = {}) {
    if (!aiProviders.deepseek) throw new Error('DeepSeek not configured');
    
    const response = await axios.post(
      `${aiProviders.deepseek.baseURL}/chat/completions`,
      {
        model: options.model || 'deepseek-chat',
        messages,
        max_tokens: options.maxTokens || config.maxTokens,
        temperature: options.temperature || 0.7
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
  }

  async callAnthropic(messages, options = {}) {
    if (!aiProviders.anthropic) throw new Error('Anthropic not configured');
    
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
  }

  async processMessage(sessionId, message, options = {}) {
    try {
      const conversation = this.memoryManager.getConversation(sessionId);
      
      const messages = [
        {
          role: 'system',
          content: 'You are an advanced AI assistant. Provide helpful, accurate, and engaging responses.'
        },
        ...conversation.slice(-5),
        { role: 'user', content: message }
      ];

      const providers = ['openai', 'deepseek', 'anthropic'];
      const response = await this.callAI(providers, messages, options);
      
      this.memoryManager.addMessage(sessionId, { role: 'user', content: message });
      this.memoryManager.addMessage(sessionId, { 
        role: 'assistant', 
        content: response.content,
        provider: response.provider,
        model: response.model
      });
      
      return response;
      
    } catch (error) {
      logger.error('Message processing failed:', error.message);
      return {
        content: "I apologize, but I encountered an error. Please try again.",
        provider: 'fallback',
        model: 'error-handler',
        error: error.message
      };
    }
  }

  getStats() {
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      uptime: Date.now() - this.startTime,
      memory: this.memoryManager.getStats(),
      providers: this.providerWeights
    };
  }
}

// Initialize
const agiAgent = new SimpleAGIAgent();
const app = express();
const server = createServer(app);

// Middleware
app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// Routes
app.get('/', (req, res) => {
  const htmlPath = join(__dirname, 'advanced_ai_agent_interface.html');
  
  fs.readFile(htmlPath, 'utf8')
    .then(html => res.send(html))
    .catch(() => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>AGI Agent</title></head>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h1>🤖 AGI Agent Running!</h1>
          <p>✅ Server is healthy</p>
          <p><strong>Database:</strong> ${dbConnected ? 'Connected' : 'Disconnected'}</p>
          <p><strong>Providers:</strong> ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ')}</p>
          <h3>Endpoints:</h3>
          <ul style="text-align: left; max-width: 400px; margin: 0 auto;">
            <li>POST /api/chat - Chat with AI</li>
            <li>POST /api/feedback - Submit feedback</li>
            <li>GET /api/stats - Get statistics</li>
            <li>WebSocket /ws - Real-time chat</li>
          </ul>
        </body>
        </html>
      `);
    });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'agi-agent',
    timestamp: new Date().toISOString(),
    database: dbConnected,
    providers: Object.keys(aiProviders).filter(p => aiProviders[p])
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, provider = 'auto', options = {} } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    const sessionId = req.session.id || crypto.randomUUID();
    if (!req.session.id) req.session.id = sessionId;
    
    const response = await agiAgent.processMessage(sessionId, message, options);
    
    // Log to database
    if (pool && dbConnected) {
      try {
        const logResult = await pool.query(
          'INSERT INTO chat_logs (session_id, message, response, provider) VALUES ($1, $2, $3, $4) RETURNING id',
          [sessionId, message, response.content, response.provider]
        );
        response.messageId = logResult.rows[0].id;
      } catch (dbError) {
        logger.warn('Database logging failed:', dbError.message);
      }
    }
    
    res.json({
      response: response.content,
      provider: response.provider,
      model: response.model,
      usage: response.usage,
      messageId: response.messageId || null
    });
    
  } catch (error) {
    logger.error('Chat API error:', error.message);
    res.status(500).json({ error: 'Chat processing failed' });
  }
});

app.post('/api/feedback', async (req, res) => {
  try {
    const { messageId, rating } = req.body;
    const sessionId = req.session.id;
    
    if (!messageId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Valid messageId and rating (1-5) required' });
    }
    
    if (pool && dbConnected) {
      await pool.query(
        'INSERT INTO feedback (session_id, message_id, rating) VALUES ($1, $2, $3)',
        [sessionId, messageId, rating]
      );
    }
    
    res.json({ success: true });
    
  } catch (error) {
    logger.error('Feedback API error:', error.message);
    res.status(500).json({ error: 'Feedback failed' });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = agiAgent.getStats();
    stats.system = {
      nodeVersion: process.version,
      platform: process.platform,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Stats failed' });
  }
});

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const sessionId = crypto.randomUUID();
  logger.info('WebSocket connected:', sessionId);

  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to AGI Agent',
    sessionId
  }));

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'chat') {
        const response = await agiAgent.processMessage(sessionId, message.content);
        
        ws.send(JSON.stringify({
          type: 'chat_response',
          content: response.content,
          provider: response.provider,
          model: response.model
        }));
      }
    } catch (error) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Processing failed'
      }));
    }
  });

  ws.on('close', () => {
    logger.info('WebSocket disconnected:', sessionId);
  });
});

// Error handlers
app.use((error, req, res, next) => {
  logger.error('Request error:', error.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Shutdown handling
process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  server.close();
  if (pool) await pool.end();
  process.exit(0);
});

// Start server
async function startServer() {
  try {
    await initializeDatabase();
    
    server.listen(config.port, config.host, () => {
      logger.info(`🚀 AGI Agent running on http://${config.host}:${config.port}`);
      logger.info(`💾 Database: ${dbConnected ? 'Connected' : 'Disconnected'}`);
      logger.info(`🤖 Providers: ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ')}`);
    });
    
  } catch (error) {
    logger.error('Startup failed:', error.message);
    process.exit(1);
  }
}

startServer();

export default app;
