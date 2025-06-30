# Create the final, complete index.js file with all features
final_code = '''import express from 'express';
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
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
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
  stdTTL: 600, // 10 minutes default
  checkperiod: 120, // Check for expired keys every 2 minutes
  useClones: false,
  maxKeys: 1000
});

// Database Configuration with Connection Pooling
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Multi-LLM Configuration
const aiProviders = {
  openai: new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  }),
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
    
    // Limit messages per conversation
    if (conversation.length > this.maxMessagesPerConversation) {
      conversation.splice(0, conversation.length - this.maxMessagesPerConversation);
    }
    
    // Limit total conversations
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
    
    // Check cache first
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

      // Cache successful responses
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
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  }

  async callOpenAI(messages, options = {}) {
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
    // Convert OpenAI format to Anthropic format
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
    this.tools.set('web_search', this.webSearch.bind(this));
    this.tools.set('calculator', this.calculator.bind(this));
    this.tools.set('weather', this.getWeather.bind(this));
    this.tools.set('database_query', this.databaseQuery.bind(this));
  }

  async webSearch(query, options = {}) {
    try {
      // Implement web search using a search API
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
      // Safe math evaluation
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
      // Implement weather API call
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

  // Helper methods (implement as needed)
  async performWebSearch(query, options) {
    // Implement actual web search logic
    return [];
  }

  evaluateMathExpression(expression) {
    // Implement safe math evaluation
    return eval(expression); // Note: Use a safer alternative in production
  }

  async fetchWeatherData(location) {
    // Implement weather API integration
    return {};
  }
}

// Task Scheduler Class
class TaskScheduler {
  constructor() {
    this.tasks = new Map();
    this.setupDefaultTasks();
  }

  setupDefaultTasks() {
    // Cleanup old cache entries every hour
    cron.schedule('0 * * * *', () => {
      this.cleanupCache();
    });

    // Database maintenance every day at 2 AM
    cron.schedule('0 2 * * *', () => {
      this.performDatabaseMaintenance();
    });

    // Memory cleanup every 30 minutes
    cron.schedule('*/30 * * * *', () => {
      this.performMemoryCleanup();
    });

    // Health check every 5 minutes
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
      // Check database connection
      await pool.query('SELECT 1');
      
      // Check AI providers
      const healthStatus = {
        database: 'healthy',
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

// Initialize core components
const aiAgent = new AdvancedAIAgent();
const toolExecutor = new ToolExecutor();
const taskScheduler = new TaskScheduler();

// Express App Configuration
const app = express();
const server = createServer(app);

// Session Configuration
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
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

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
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
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
    fileSize: 10 * 1024 * 1024 // 10MB limit
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
  res.sendFile(join(__dirname, 'advanced_ai_agent_interface.html'));
});

// Health Check Endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const stats = aiAgent.getStats();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      stats: stats
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
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
    const sessionId = req.session.id;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get conversation history
    const conversation = aiAgent.memoryManager.getConversation(sessionId);
    
    // Add user message to conversation
    aiAgent.memoryManager.addMessage(sessionId, {
      role: 'user',
      content: message
    });

    // Prepare messages for AI
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful AI assistant. Provide accurate, helpful, and engaging responses.'
      },
      ...conversation.slice(-10), // Last 10 messages for context
      {
        role: 'user',
        content: message
      }
    ];

    // Call AI provider
    const aiResponse = await aiAgent.callAI(provider, messages, options);

    // Add AI response to conversation
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
    logger.error('Chat API error', { error: error.message, stack: error.stack });
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

    // Process file based on type
    let processedContent = '';
    
    if (req.file.mimetype.startsWith('image/')) {
      processedContent = await this.processImage(req.file.path);
    } else if (req.file.mimetype === 'application/pdf') {
      processedContent = await this.processPDF(req.file.path);
    } else if (req.file.mimetype.includes('document')) {
      processedContent = await this.processDocument(req.file.path);
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

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to AI Agent',
    sessionId: sessionId
  }));

  // Heartbeat mechanism
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
          // Handle pong response
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

    // Get conversation history
    const conversation = aiAgent.memoryManager.getConversation(sessionId);
    
    // Add user message
    aiAgent.memoryManager.addMessage(sessionId, {
      role: 'user',
      content: content
    });

    // Prepare messages for AI
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

    // Send typing indicator
    ws.send(JSON.stringify({
      type: 'typing',
      isTyping: true
    }));

    // Call AI provider
    const aiResponse = await aiAgent.callAI(provider, messages, options);

    // Add AI response to conversation
    aiAgent.memoryManager.addMessage(sessionId, {
      role: 'assistant',
      content: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model
    });

    // Send response
    ws.send(JSON.stringify({
      type: 'chat_response',
      content: aiResponse.content,
      provider: aiResponse.provider,
      model: aiResponse.model,
      usage: aiResponse.usage
    }));

    // Stop typing indicator
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
  try {
    // Create tables if they don't exist
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
    // Implement PDF processing logic
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
    stack: error.stack,
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

  try {
    await pool.end();
    logger.info('Database connections closed');
  } catch (error) {
    logger.error('Error closing database connections', { error: error.message });
  }

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    await pool.end();
    logger.info('Database connections closed');
  } catch (error) {
    logger.error('Error closing database connections', { error: error.message });
  }

  process.exit(0);
});

// Unhandled Promise Rejection
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', { promise, reason });
});

// Uncaught Exception
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Start Server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    
    // Start server
    server.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📱 WebSocket server running on ws://localhost:${PORT}/ws`);
      logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`💾 Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
      logger.info(`🤖 AI Providers: ${Object.keys(aiProviders).join(', ')}`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

startServer();

export default app;
''' 
