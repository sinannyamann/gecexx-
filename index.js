import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pkg from 'pg';
const { Pool } = pkg;
import OpenAI from 'openai';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import winston from 'winston';
import NodeCache from 'node-cache';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import multer from 'multer';
import mammoth from 'mammoth';
import sharp from 'sharp';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Logger Configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'ai-agent' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Cache Configuration
const cache = new NodeCache({ 
  stdTTL: 600,
  checkperiod: 120,
  useClones: false,
  maxKeys: 1000
});

// Environment Validation
function validateEnvironment() {
  const warnings = [];
  
  if (!process.env.DATABASE_URL) {
    warnings.push('DATABASE_URL not set - database features will be limited');
  }
  
  const aiKeys = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY'];
  const availableProviders = aiKeys.filter(key => process.env[key]);
  
  if (availableProviders.length === 0) {
    warnings.push('No AI provider keys found - AI features will be limited');
  }
  
  warnings.forEach(warning => logger.warn(warning));
  logger.info(`Available AI providers: ${availableProviders.length}`);
}

// Safe Database Configuration
let pool = null;
let dbConnected = false;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    logger.info('💾 Database: Not configured');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      acquireTimeoutMillis: 60000,
      createTimeoutMillis: 30000,
      destroyTimeoutMillis: 5000,
      reapIntervalMillis: 1000,
      createRetryIntervalMillis: 200,
    });

    // Test connection
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    // Create tables if they don't exist
    await createTables();
    
    dbConnected = true;
    logger.info('💾 Database: Connected successfully');
    return true;
  } catch (error) {
    logger.error('Database initialization failed', { error: error.message });
    pool = null;
    dbConnected = false;
    return false;
  }
}

async function createTables() {
  if (!pool) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      ) WITH (OIDS=FALSE);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS IDX_session_expire ON user_sessions(expire);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_logs (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        message TEXT,
        response TEXT,
        provider VARCHAR(50),
        model VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info('Database tables created/verified');
  } catch (error) {
    logger.error('Table creation failed', { error: error.message });
  }
}

// AI Providers Configuration
const aiProviders = {
  openai: process.env.OPENAI_API_KEY ? new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  }) : null,
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1'
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.anthropic.com/v1'
  }
};

// Memory Manager
class MemoryManager {
  constructor() {
    this.conversations = new Map();
    this.maxConversations = 500;
    this.maxMessagesPerConversation = 20;
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
    
    if (conversation.length > this.maxMessagesPerConversation) {
      conversation.splice(0, conversation.length - this.maxMessagesPerConversation);
    }
    
    if (this.conversations.size > this.maxConversations) {
      const oldestKey = this.conversations.keys().next().value;
      this.conversations.delete(oldestKey);
    }
  }

  getConversation(sessionId) {
    return this.conversations.get(sessionId) || [];
  }

  clearConversation(sessionId) {
    this.conversations.delete(sessionId);
  }

  getStats() {
    return {
      totalConversations: this.conversations.size,
      totalMessages: Array.from(this.conversations.values()).reduce((sum, conv) => sum + conv.length, 0)
    };
  }
}

// AI Agent Class
class AIAgent {
  constructor() {
    this.memoryManager = new MemoryManager();
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
  }

  async callAI(provider, messages, options = {}) {
    const cacheKey = `ai_${provider}_${crypto.createHash('md5').update(JSON.stringify(messages)).digest('hex')}`;
    
    const cachedResponse = cache.get(cacheKey);
    if (cachedResponse && !options.skipCache) {
      return cachedResponse;
    }

    try {
      this.requestCount++;
      let response;

      switch (provider) {
        case 'openai':
          response = await this.callOpenAI(messages, options);
          break;
        case 'deepseek':
          response = await this.callDeepSeek(messages, options);
          break;
        case 'anthropic':
          response = await this.callAnthropic(messages, options);
          break;
        default:
          throw new Error(`Unsupported AI provider: ${provider}`);
      }

      cache.set(cacheKey, response, options.cacheTTL || 300);
      return response;
    } catch (error) {
      this.errorCount++;
      logger.error('AI request failed', { provider, error: error.message });
      throw error;
    }
  }

  async callOpenAI(messages, options = {}) {
    if (!aiProviders.openai) {
      throw new Error('OpenAI API key not configured');
    }

    const response = await aiProviders.openai.chat.completions.create({
      model: options.model || 'gpt-4o-mini',
      messages: messages,
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature || 0.7,
      stream: false
    });

    return {
      content: response.choices[0].message.content,
      usage: response.usage,
      model: response.model,
      provider: 'openai'
    };
  }

  async callDeepSeek(messages, options = {}) {
    if (!aiProviders.deepseek.apiKey) {
      throw new Error('DeepSeek API key not configured');
    }

    const response = await axios.post(
      `${aiProviders.deepseek.baseURL}/chat/completions`,
      {
        model: options.model || 'deepseek-chat',
        messages: messages,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${aiProviders.deepseek.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
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
    if (!aiProviders.anthropic.apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    const systemMessage = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');

    const response = await axios.post(
      `${aiProviders.anthropic.baseURL}/messages`,
      {
        model: options.model || 'claude-3-sonnet-20240229',
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || 0.7,
        system: systemMessage?.content || '',
        messages: userMessages
      },
      {
        headers: {
          'x-api-key': aiProviders.anthropic.apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        },
        timeout: 30000
      }
    );

    return {
      content: response.data.content[0].text,
      usage: response.data.usage,
      model: response.data.model,
      provider: 'anthropic'
    };
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      uptime: Date.now() - this.startTime,
      memoryStats: this.memoryManager.getStats(),
      cacheStats: cache.getStats()
    };
  }
}

// Initialize components
const aiAgent = new AIAgent();

// Express App Configuration
const app = express();
const server = createServer(app);

// Trust proxy for Railway
app.set('trust proxy', 1);

// Session Configuration
const sessionConfig = {
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
};

// Use database session store if available
if (pool) {
  const PgSession = connectPgSimple(session);
  sessionConfig.store = new PgSession({
    pool: pool,
    tableName: 'user_sessions'
  });
}

app.use(session(sessionConfig));

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"]
    }
  }
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// CORS Configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || true,
  credentials: true
}));

// Compression and Parsing
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// File Upload Configuration
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/', 'application/pdf', 'application/vnd.openxmlformats-officedocument'];
    if (allowedTypes.some(type => file.mimetype.startsWith(type))) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'), false);
    }
  }
});

// Static Files
app.use(express.static(join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    service: 'ai-agent',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbConnected ? 'connected' : 'disconnected'
  });
});

// Health Check
app.get('/health', async (req, res) => {
  const healthCheck = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    service: 'ai-agent',
    database: dbConnected ? 'connected' : 'disconnected'
  };

  try {
    if (pool && dbConnected) {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('DB timeout')), 2000)
        )
      ]);
      healthCheck.database = 'connected';
    }
    
    healthCheck.stats = aiAgent.getStats();
    res.status(200).json(healthCheck);
    
  } catch (error) {
    healthCheck.database = 'error';
    healthCheck.database_error = error.message;
    res.status(200).json(healthCheck);
  }
});

// Chat API
app.post('/api/chat', async (req, res) => {
  try {
    const { message, provider = 'openai', options = {} } = req.body;
    const sessionId = req.session.id || crypto.randomUUID();

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const conversation = aiAgent.memoryManager.getConversation(sessionId);
    
    aiAgent.memoryManager.addMessage(sessionId, {
      role: 'user',
      content: message
    });

    const messages = [
      {
        role: 'system',
        content: 'You are a helpful AI assistant. Provide accurate, helpful, and engaging responses.'
      },
      ...conversation.slice(-10),
      {
        role: 'user',
        content: message
      }
    ];

    const aiResponse = await aiAgent.callAI(provider, messages, options);

    aiAgent.memoryManager.addMessage(sessionId, {
      role: 'assistant',
      content: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model
    });

    // Log to database if available
    if (pool && dbConnected) {
      try {
        await pool.query(
          'INSERT INTO chat_logs (session_id, message, response, provider, model) VALUES ($1, $2, $3, $4, $5)',
          [sessionId, message, aiResponse.content, aiResponse.provider, aiResponse.model]
        );
      } catch (dbError) {
        logger.warn('Failed to log chat to database', { error: dbError.message });
      }
    }

    res.json({
      response: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model,
      usage: aiResponse.usage
    });

  } catch (error) {
    logger.error('Chat API error', { error: error.message });
    res.status(500).json({ 
      error: 'An error occurred while processing your request',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// File Upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileInfo = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path
    };

    let processedContent = '';
    
    try {
      if (req.file.mimetype.startsWith('image/')) {
        const metadata = await sharp(req.file.path).metadata();
        processedContent = `Image: ${metadata.width}x${metadata.height}, ${metadata.format}`;
      } else if (req.file.mimetype.includes('document')) {
        const result = await mammoth.extractRawText({ path: req.file.path });
        processedContent = result.value.substring(0, 1000);
      }
    } catch (processError) {
      logger.warn('File processing failed', { error: processError.message });
      processedContent = 'File uploaded but processing failed';
    }

    res.json({
      success: true,
      file: fileInfo,
      content: processedContent
    });

  } catch (error) {
    logger.error('File upload error', { error: error.message });
    res.status(500).json({ error: 'File upload failed' });
  }
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const stats = aiAgent.getStats();
  res.json(stats);
});

// WebSocket Configuration
const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});

wss.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  
  logger.info('WebSocket connection established', { sessionId });

  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to AI Agent',
    sessionId: sessionId
  }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'chat') {
        await handleWebSocketChat(ws, message, sessionId);
      }
    } catch (error) {
      logger.error('WebSocket message error', { error: error.message });
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Message processing failed'
      }));
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    logger.info('WebSocket connection closed', { sessionId });
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error', { sessionId, error: error.message });
  });
});

async function handleWebSocketChat(ws, message, sessionId) {
  try {
    const { content, provider = 'openai', options = {} } = message;

    const conversation = aiAgent.memoryManager.getConversation(sessionId);
    
    aiAgent.memoryManager.addMessage(sessionId, {
      role: 'user',
      content: content
    });

    const messages = [
      {
        role: 'system',
        content: 'You are a helpful AI assistant.'
      },
      ...conversation.slice(-10),
      {
        role: 'user',
        content: content
      }
    ];

    ws.send(JSON.stringify({
      type: 'typing',
      isTyping: true
    }));

    const aiResponse = await aiAgent.callAI(provider, messages, options);

    aiAgent.memoryManager.addMessage(sessionId, {
      role: 'assistant',
      content: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model
    });

    ws.send(JSON.stringify({
      type: 'chat_response',
      content: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model,
      usage: aiResponse.usage
    }));

    ws.send(JSON.stringify({
      type: 'typing',
      isTyping: false
    }));

  } catch (error) {
    logger.error('WebSocket chat error', { error: error.message });
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Chat processing failed'
    }));
  }
}

// Cleanup tasks
cron.schedule('0 * * * *', () => {
  cache.flushAll();
  logger.info('Cache cleaned');
});

// Error Handling
app.use((error, req, res, next) => {
  logger.error('Unhandled error', { 
    error: error.message, 
    url: req.url,
    method: req.method
  });

  res.status(500).json({
    error: 'Internal server error'
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found'
  });
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
  });

  if (pool) {
    try {
      await pool.end();
      logger.info('Database connections closed');
    } catch (error) {
      logger.error('Error closing database', { error: error.message });
    }
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message });
  process.exit(1);
});

// Start Server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

async function startServer() {
  try {
    validateEnvironment();
    
    server.listen(PORT, HOST, () => {
      logger.info(`🚀 Server running on ${HOST}:${PORT}`);
      logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
    
    // Initialize database in background
    setTimeout(async () => {
      await initializeDatabase();
    }, 1000);
    
  } catch (error) {
    logger.error('Server startup error', { error: error.message });
    process.exit(1);
  }
}

startServer();

export default app;
