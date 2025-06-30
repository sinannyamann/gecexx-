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
import pdf2pic from 'pdf2pic';
import sharp from 'sharp';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import crypto from 'crypto';
import { promisify } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Enhanced Logger Configuration
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

// Railway specific logging
if (process.env.RAILWAY_ENVIRONMENT) {
  logger.add(new winston.transports.Console({
    format: winston.format.json()
  }));
}

// Enhanced Cache Configuration
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
    warnings.push('DATABASE_URL not set - database features disabled');
  }
  
  const aiKeys = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY'];
  const availableProviders = aiKeys.filter(key => process.env[key]);
  
  if (availableProviders.length === 0) {
    warnings.push('No AI provider keys found');
  }
  
  warnings.forEach(warning => logger.warn(warning));
  logger.info(`Available AI providers: ${availableProviders.length}`);
}

// Database Configuration with Connection Pooling
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    acquireTimeoutMillis: 60000,
    createTimeoutMillis: 30000,
    destroyTimeoutMillis: 5000,
    reapIntervalMillis: 1000,
    createRetryIntervalMillis: 200,
  });
}

// Multi-LLM Configuration
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

// Memory Management Class
class MemoryManager {
  constructor() {
    this.conversations = new Map();
    this.maxConversations = 1000;
    this.maxMessagesPerConversation = 50;
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

// Advanced AI Agent Class
class AdvancedAIAgent {
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
      logger.info('Returning cached AI response', { provider, cacheKey });
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
      
      logger.info('AI request successful', { 
        provider, 
        messageCount: messages.length,
        responseLength: response.content?.length || 0
      });

      return response;
    } catch (error) {
      this.errorCount++;
      logger.error('AI request failed', { 
        provider, 
        error: error.message
      });
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
      max_tokens: options.maxTokens || 2000,
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
        max_tokens: options.maxTokens || 2000,
        temperature: options.temperature || 0.7,
        stream: false
      },
      {
        headers: {
          'Authorization': `Bearer ${aiProviders.deepseek.apiKey}`,
          'Content-Type': 'application/json'
        }
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
        max_tokens: options.maxTokens || 2000,
        temperature: options.temperature || 0.7,
        system: systemMessage?.content || '',
        messages: userMessages
      },
      {
        headers: {
          'x-api-key': aiProviders.anthropic.apiKey,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        }
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

// Tool Executor Class
class ToolExecutor {
  constructor() {
    this.tools = new Map();
    this.registerDefaultTools();
  }

  registerDefaultTools() {
    this.tools.set('Web Search', this.webSearch.bind(this));
    this.tools.set('calculator', this.calculator.bind(this));
    this.tools.set('weather', this.getWeather.bind(this));
    this.tools.set('database_query', this.databaseQuery.bind(this));
  }

  async webSearch(query, options = {}) {
    try {
      const searchResults = await this.performWebSearch(query, options);
      return {
        success: true,
        results: searchResults,
        query: query
      };
    } catch (error) {
      logger.error('Web search failed', { query, error: error.message });
      return {
        success: false,
        error: error.message,
        query: query
      };
    }
  }

  async calculator(expression) {
    try {
      const result = this.evaluateMathExpression(expression);
      return {
        success: true,
        result: result,
        expression: expression
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        expression: expression
      };
    }
  }

  async getWeather(location) {
    try {
      const weatherData = await this.fetchWeatherData(location);
      return {
        success: true,
        data: weatherData,
        location: location
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        location: location
      };
    }
  }

  async databaseQuery(query, params = []) {
    if (!pool) {
      return {
        success: false,
        error: 'Database not configured'
      };
    }

    try {
      const result = await pool.query(query, params);
      return {
        success: true,
        rows: result.rows,
        rowCount: result.rowCount
      };
    } catch (error) {
      logger.error('Database query failed', { query, error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }

  async performWebSearch(query, options) {
    return [];
  }

  evaluateMathExpression(expression) {
    // Basit matematik işlemleri için güvenli değerlendirme
    const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, '');
    return Function('"use strict"; return (' + sanitized + ')')();
  }

  async fetchWeatherData(location) {
    return { location, temperature: '20°C', condition: 'Sunny' };
  }
}

// Task Scheduler Class
class TaskScheduler {
  constructor() {
    this.tasks = new Map();
    this.setupDefaultTasks();
  }

  setupDefaultTasks() {
    cron.schedule('0 * * * *', () => {
      this.cleanupCache();
    });

    if (pool) {
      cron.schedule('0 2 * * *', () => {
        this.performDatabaseMaintenance();
      });
    }

    cron.schedule('*/30 * * * *', () => {
      this.performMemoryCleanup();
    });

    cron.schedule('*/5 * * * *', () => {
      this.performHealthCheck();
    });
  }

  cleanupCache() {
    const stats = cache.getStats();
    logger.info('Cache cleanup started', stats);
    cache.flushAll();
    logger.info('Cache cleanup completed');
  }

  async performDatabaseMaintenance() {
    if (!pool) return;
    
    try {
      await pool.query('VACUUM ANALYZE;');
      logger.info('Database maintenance completed');
    } catch (error) {
      logger.error('Database maintenance failed', { error: error.message });
    }
  }

  performMemoryCleanup() {
    if (global.gc) {
      global.gc();
      logger.info('Memory cleanup performed');
    }
  }

  async performHealthCheck() {
    try {
      if (pool) {
        await pool.query('SELECT 1');
      }
      
      const healthStatus = {
        database: pool ? 'healthy' : 'not_configured',
        cache: cache.getStats(),
        memory: process.memoryUsage(),
        uptime: process.uptime()
      };
      
      logger.debug('Health check completed', healthStatus);
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
    }
  }
}

// Test database connection
async function testDatabaseConnection() {
  if (!pool) {
    logger.info('Database not configured, skipping connection test');
    return false;
  }

  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    logger.info('Database connection successful');
    return true;
  } catch (error) {
    logger.error('Database connection failed', { error: error.message });
    return false;
  }
}

// Initialize core components
const aiAgent = new AdvancedAIAgent();
const toolExecutor = new ToolExecutor();
const taskScheduler = new TaskScheduler();

// Express App Configuration
const app = express();
const server = createServer(app);

// Session Configuration
if (pool) {
  const PgSession = connectPgSimple(session);
  app.use(session({
    store: new PgSession({
      pool: pool,
      tableName: 'user_sessions'
    }),
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000
    }
  }));
} else {
  // Memory session fallback
  app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000
    }
  }));
}

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  }
}));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// CORS Configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
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
    uptime: process.uptime()
  });
});

// Enhanced Health Check Endpoint
app.get('/health', async (req, res) => {
  const healthCheck = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    service: 'ai-agent'
  };

  try {
    if (pool) {
      const dbCheck = await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('DB timeout')), 2000)
        )
      ]);
      healthCheck.database = 'connected';
    } else {
      healthCheck.database = 'not_configured';
    }
    
    healthCheck.stats = aiAgent.getStats();
    res.status(200).json(healthCheck);
    
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    
    healthCheck.status = 'degraded';
    healthCheck.database = 'disconnected';
    healthCheck.error = error.message;
    
    res.status(200).json(healthCheck);
  }
});

// Statistics Endpoint
app.get('/api/stats', (req, res) => {
  const stats = aiAgent.getStats();
  res.json(stats);
});

// Chat API Endpoint
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

// File Upload Endpoint
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
    
    if (req.file.mimetype.startsWith('image/')) {
      processedContent = await processImage(req.file.path);
    } else if (req.file.mimetype === 'application/pdf') {
      processedContent = await processPDF(req.file.path);
    } else if (req.file.mimetype.includes('document')) {
      processedContent = await processDocument(req.file.path);
    }

    res.json({
      success: true,
      file: fileInfo,
      content: processedContent
    });

  } catch (error) {
    logger.error('File upload error', { error: error.message });
    res.status(500).json({ error: 'File processing failed' });
  }
});

// Tool Execution Endpoint
app.post('/api/tools/:toolName', async (req, res) => {
  try {
    const { toolName } = req.params;
    const { params } = req.body;

    if (!toolExecutor.tools.has(toolName)) {
      return res.status(404).json({ error: 'Tool not found' });
    }

    const result = await toolExecutor.tools.get(toolName)(params);
    res.json(result);

  } catch (error) {
    logger.error('Tool execution error', { toolName: req.params.toolName, error: error.message });
    res.status(500).json({ error: 'Tool execution failed' });
  }
});

// WebSocket Configuration
const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});

// WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  const sessionId = req.session?.id || crypto.randomUUID();
  
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
      
      switch (message.type) {
        case 'chat':
          await handleWebSocketChat(ws, message, sessionId);
          break;
        case 'tool':
          await handleWebSocketTool(ws, message, sessionId);
          break;
        case 'pong':
          break;
        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Unknown message type'
          }));
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

// WebSocket Chat Handler
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
        content: 'You are a helpful AI assistant. Provide accurate, helpful, and engaging responses.'
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

// WebSocket Tool Handler
async function handleWebSocketTool(ws, message, sessionId) {
  try {
    const { toolName, params } = message;

    if (!toolExecutor.tools.has(toolName)) {
      ws.send(JSON.stringify({
        type: 'tool_error',
        message: 'Tool not found'
      }));
      return;
    }

    const result = await toolExecutor.tools.get(toolName)(params);
    
    ws.send(JSON.stringify({
      type: 'tool_response',
      toolName: toolName,
      result: result
    }));

  } catch (error) {
    logger.error('WebSocket tool error', { error: error.message });
    ws.send(JSON.stringify({
      type: 'tool_error',
      message: 'Tool execution failed'
    }));
  }
}

// Database Initialization
async function initializeDatabase() {
  if (!pool) {
    logger.info('Database not configured, skipping initialization');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      ) WITH (OIDS=FALSE);
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS file_uploads (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255),
        original_name VARCHAR(255),
        mimetype VARCHAR(100),
        size INTEGER,
        processed_content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info('Database initialized successfully');
  } catch (error) {
    logger.error('Database initialization failed', { error: error.message });
    throw error;
  }
}

// File Processing Functions
async function processImage(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return `Image processed: ${metadata.width}x${metadata.height}, format: ${metadata.format}`;
  } catch (error) {
    logger.error('Image processing failed', { error: error.message });
    return 'Image processing failed';
  }
}

async function processPDF(filePath) {
  try {
    return 'PDF processed successfully';
  } catch (error) {
    logger.error('PDF processing failed', { error: error.message });
    return 'PDF processing failed';
  }
}

async function processDocument(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } catch (error) {
    logger.error('Document processing failed', { error: error.message });
    return 'Document processing failed';
  }
}

// Error Handling Middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error', { 
    error: error.message, 
    url: req.url,
    method: req.method
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: 'The requested resource was not found'
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
      logger.error('Error closing database connections', { error: error.message });
    }
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
  });

  if (pool) {
    try {
      await pool.end();
      logger.info('Database connections closed');
    } catch (error) {
      logger.error('Error closing database connections', { error: error.message });
    }
  }

  process.exit(0);
});

// Unhandled Promise Rejection
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

// Uncaught Exception
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error: error.message });
  process.exit(1);
});

// Start Server
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

async function startServer() {
  try {
    // Validate environment
    validateEnvironment();
    
    // Start server immediately
    server.listen(PORT, HOST, () => {
      logger.info(`🚀 Server running on ${HOST}:${PORT}`);
      logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`💾 Database: ${pool ? 'Configured' : 'Not configured'}`);
    });
    
    // Initialize database in background
    setTimeout(async () => {
      try {
        const dbConnected = await testDatabaseConnection();
        if (dbConnected) {
          await initializeDatabase();
          logger.info('Database initialized');
        }
      } catch (error) {
        logger.error('Database initialization failed', { error: error.message });
      }
    }, 1000);
    
  } catch (error) {
    logger.error('Server startup error', { error: error.message });
    
    // Try to start server anyway for health checks
    server.listen(PORT, HOST, () => {
      logger.info(`🚀 Server running in degraded mode on ${HOST}:${PORT}`);
    });
  }
}

startServer();

export default app;
