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
import { EventEmitter } from 'events';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Enhanced Configuration
const config = {
  port: process.env.PORT || 3000,
  host: '0.0.0.0',
  maxTokens: 8000,
  defaultModel: 'gpt-4o',
  memoryRetentionDays: 30,
  maxConversationLength: 50,
  reasoningDepth: 3,
  toolTimeout: 30000,
  learningRate: 0.1
};

// Advanced Logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Enhanced Cache with categories
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 300 });
const longTermCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// Enhanced Database with more tables
let pool = null;
let dbConnected = false;

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    logger.warn('Database not configured - using memory only');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();

    // Create enhanced tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255) UNIQUE,
        user_profile JSONB,
        preferences JSONB,
        context JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        role VARCHAR(50),
        content TEXT,
        metadata JSONB,
        reasoning JSONB,
        tools_used JSONB,
        confidence_score FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    logger.info('Enhanced database initialized');
    dbConnected = true;
    return true;
  } catch (error) {
    logger.error('Database initialization failed:', error);
    return false;
  }
}

// Enhanced AI Providers with more options
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

// Simplified Tool System for basic functionality
class BasicToolSystem extends EventEmitter {
  constructor() {
    super();
    this.tools = new Map();
    this.registerBasicTools();
  }

  registerTool(name, tool) {
    this.tools.set(name, tool);
    logger.info(`Tool registered: ${name}`);
  }

  async executeTool(name, params, context = {}) {
    const startTime = Date.now();
    
    try {
      if (!this.tools.has(name)) {
        throw new Error(`Tool ${name} not found`);
      }

      const tool = this.tools.get(name);
      const result = await Promise.race([
        tool.execute(params, context),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Tool execution timeout')), config.toolTimeout)
        )
      ]);

      const duration = Date.now() - startTime;
      this.emit('toolExecuted', { name, params, result, duration, success: true });
      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      this.emit('toolExecuted', { name, params, error: error.message, duration, success: false });
      throw error;
    }
  }

  registerBasicTools() {
    // Basic Echo Tool for testing
    this.registerTool('echo', {
      name: 'echo',
      description: 'Echo back the input',
      parameters: {
        message: { type: 'string', required: true }
      },
      execute: async (params) => {
        return { echo: params.message };
      }
    });

    // Memory Tool
    this.registerTool('memory_store', {
      name: 'memory_store',
      description: 'Store information in memory',
      parameters: {
        key: { type: 'string', required: true },
        value: { type: 'any', required: true }
      },
      execute: async (params, context) => {
        longTermCache.set(`${context.sessionId}:${params.key}`, params.value);
        return { stored: true };
      }
    });
  }
}

// Simplified Memory Manager
class BasicMemoryManager {
  constructor() {
    this.conversations = new Map();
    this.userProfiles = new Map();
    this.maxMessages = config.maxConversationLength;
  }

  async loadConversation(sessionId) {
    if (this.conversations.has(sessionId)) {
      return this.conversations.get(sessionId);
    }

    if (pool && dbConnected) {
      try {
        const result = await pool.query(
          'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2',
          [sessionId, this.maxMessages]
        );
        
        const messages = result.rows.reverse().map(row => ({
          role: row.role,
          content: row.content,
          metadata: row.metadata,
          timestamp: row.created_at
        }));

        this.conversations.set(sessionId, messages);
        return messages;
      } catch (error) {
        logger.error('Failed to load conversation:', error);
        return [];
      }
    }

    return [];
  }

  async saveMessage(sessionId, message) {
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }
    
    const conversation = this.conversations.get(sessionId);
    const enhancedMessage = {
      ...message,
      timestamp: new Date().toISOString(),
      id: crypto.randomUUID()
    };
    
    conversation.push(enhancedMessage);
    
    if (conversation.length > this.maxMessages) {
      conversation.splice(0, conversation.length - this.maxMessages);
    }
    
    if (pool && dbConnected) {
      try {
        await pool.query(
          'INSERT INTO messages (session_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
          [sessionId, message.role, message.content, message.metadata || {}]
        );
      } catch (error) {
        logger.error('Failed to save message:', error);
      }
    }
    
    return enhancedMessage;
  }

  getContextWindow(sessionId, windowSize = 10) {
    const conversation = this.conversations.get(sessionId) || [];
    return conversation.slice(-windowSize);
  }
}

// Simplified AGI Agent
class SimplifiedAGIAgent extends EventEmitter {
  constructor() {
    super();
    this.memoryManager = new BasicMemoryManager();
    this.toolSystem = new BasicToolSystem();
    
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    
    this.capabilities = {
      reasoning: false,
      learning: false,
      memory: true,
      tools: true,
      planning: false,
      multimodal: false
    };
  }

  async processMessage(sessionId, message, options = {}) {
    const startTime = Date.now();
    
    try {
      // Load conversation context
      await this.memoryManager.loadConversation(sessionId);
      const conversationContext = this.memoryManager.getContextWindow(sessionId);
      
      // Generate response
      const response = await this.generateResponse(
        sessionId,
        message,
        conversationContext,
        options
      );

      // Save to memory
      await this.memoryManager.saveMessage(sessionId, { 
        role: 'user', 
        content: message,
        metadata: { timestamp: new Date().toISOString() }
      });
      
      await this.memoryManager.saveMessage(sessionId, { 
        role: 'assistant', 
        content: response.content,
        metadata: { 
          provider: response.provider,
          model: response.model,
          confidence: response.confidence || 0.8
        }
      });

      const duration = Date.now() - startTime;
      this.requestCount++;

      const result = {
        ...response,
        processingTime: duration,
        sessionId: sessionId
      };

      this.emit('messageProcessed', {
        input: message,
        output: response.content,
        success: true,
        duration: duration,
        sessionId: sessionId
      });

      return result;

    } catch (error) {
      this.errorCount++;
      const duration = Date.now() - startTime;
      
      logger.error('Message processing failed:', error);
      
      const fallbackResponse = {
        content: "I'm sorry, I encountered an error processing your message. Please try again.",
        provider: 'fallback',
        model: 'error-handler',
        confidence: 0.1,
        error: error.message,
        processingTime: duration
      };

      this.emit('messageProcessed', {
        input: message,
        output: fallbackResponse.content,
        success: false,
        error: error.message,
        duration: duration,
        sessionId: sessionId
      });

      return fallbackResponse;
    }
  }

  async generateResponse(sessionId, message, context, options = {}) {
    // Build context for AI providers
    const enhancedContext = this.buildContext(message, context);
    
    // Select best available provider
    const provider = this.selectProvider();
    
    // Generate response using selected provider
    const response = await this.callAI(provider, enhancedContext.messages, options);
    
    return {
      ...response,
      sessionId: sessionId,
      confidence: 0.8
    };
  }

  buildContext(message, context) {
    const systemPrompt = `You are a helpful AI assistant. Provide clear, accurate, and helpful responses.`;
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...context.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      { role: 'user', content: message }
    ];

    return { messages };
  }

  selectProvider() {
    const availableProviders = Object.keys(aiProviders).filter(p => aiProviders[p]);
    
    if (availableProviders.includes('openai')) return 'openai';
    if (availableProviders.includes('deepseek')) return 'deepseek';
    if (availableProviders.includes('anthropic')) return 'anthropic';
    
    throw new Error('No AI providers available');
  }

  async callAI(provider, messages, options = {}) {
    const cacheKey = `ai_${crypto.createHash('md5').update(JSON.stringify({ provider, messages, options })).digest('hex')}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let result;
    
    try {
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
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
      
      cache.set(cacheKey, result, 1800);
      return result;
      
    } catch (error) {
      logger.error(`Provider ${provider} failed:`, error);
      throw error;
    }
  }

  async callOpenAI(messages, options = {}) {
    if (!aiProviders.openai) throw new Error('OpenAI not configured');
    
    const response = await aiProviders.openai.chat.completions.create({
      model: options.model || 'gpt-4o-mini',
      messages,
      max_tokens: options.maxTokens || config.maxTokens,
      temperature: options.temperature || 0.7
    });
    
    return {
      content: response.choices[0].message.content,
      usage: response.usage,
      model: response.model,
      provider: 'openai',
      finishReason: response.choices[0].finish_reason
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
      provider: 'deepseek',
      finishReason: response.data.choices[0].finish_reason
    };
  }

  async callAnthropic(messages, options = {}) {
    if (!aiProviders.anthropic) throw new Error('Anthropic not configured');
    
    const systemMessage = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');
    
    const response = await axios.post(
      `${aiProviders.anthropic.baseURL}/messages`,
      {
        model: options.model || 'claude-3-haiku-20240307',
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
      provider: 'anthropic',
      finishReason: response.data.stop_reason
    };
  }

  getStats() {
    const memoryStats = this.memoryManager.conversations.size;
    
    return {
      requests: this.requestCount,
      errors: this.errorCount,
      errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
      uptime: Date.now() - this.startTime,
      activeConversations: memoryStats,
      capabilities: this.capabilities,
      providers: {
        available: Object.keys(aiProviders).filter(p => aiProviders[p])
      },
      tools: {
        registered: this.toolSystem.tools.size,
        available: Array.from(this.toolSystem.tools.keys())
      }
    };
  }
}

// Initialize system
const agiAgent = new SimplifiedAGIAgent();
const app = express();
const server = createServer(app);

// Enhanced middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors({ 
  origin: process.env.ALLOWED_ORIGINS?.split(',') || true, 
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Rate limiting middleware
const requestCounts = new Map();
const rateLimit = (req, res, next) => {
  const clientId = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 60;
  
  if (!requestCounts.has(clientId)) {
    requestCounts.set(clientId, []);
  }
  
  const requests = requestCounts.get(clientId);
  const recentRequests = requests.filter(time => now - time < windowMs);
  
  if (recentRequests.length >= maxRequests) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil(windowMs / 1000)
    });
  }
  
  recentRequests.push(now);
  requestCounts.set(clientId, recentRequests);
  next();
};

app.use('/api/', rateLimit);

// Routes
app.get('/', async (req, res) => {
  try {
    const stats = agiAgent.getStats();
    
    res.send(`
      <!DOCTYPE html>
      <html lang="tr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Advanced AGI Agent</title>
        <style>
          body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            margin: 0; 
            padding: 20px; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
            color: white; 
            min-height: 100vh;
          }
          .container { max-width: 1200px; margin: 0 auto; }
          .header { text-align: center; margin-bottom: 40px; }
          .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
          .stat-card { background: rgba(255,255,255,0.1); padding: 20px; border-radius: 10px; backdrop-filter: blur(10px); }
          .stat-title { font-size: 18px; font-weight: bold; margin-bottom: 10px; }
          .stat-value { font-size: 24px; color: #ffd700; }
          .endpoints { margin-top: 40px; }
          .endpoint { background: rgba(255,255,255,0.1); margin: 10px 0; padding: 15px; border-radius: 5px; }
          .method { background: #28a745; color: white; padding: 2px 8px; border-radius: 3px; font-size: 12px; margin-right: 10px; }
          .method.get { background: #007bff; }
          .method.post { background: #28a745; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🧠 Advanced AGI Agent</h1>
            <p>AI Assistant with Memory and Tool Capabilities</p>
          </div>
          
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-title">System Status</div>
              <div class="stat-value">✅ Online</div>
              <div>Database: ${dbConnected ? '🟢 Connected' : '🟡 Memory Only'}</div>
              <div>Uptime: ${Math.floor(stats.uptime / 1000 / 60)} minutes</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-title">Performance</div>
              <div class="stat-value">${stats.requests} requests</div>
              <div>Error Rate: ${(stats.errorRate * 100).toFixed(1)}%</div>
              <div>Active Conversations: ${stats.activeConversations}</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-title">AI Providers</div>
              <div class="stat-value">${stats.providers.available.length} active</div>
              <div>${stats.providers.available.join(', ') || 'None configured'}</div>
            </div>
            
            <div class="stat-card">
              <div class="stat-title">Capabilities</div>
              <div class="stat-value">Basic Chat</div>
              <div>Tools: ${stats.tools.registered}</div>
              <div>Memory: ${stats.capabilities.memory ? 'Enabled' : 'Disabled'}</div>
            </div>
          </div>
          
          <div class="endpoints">
            <h2>API Endpoints</h2>
            <div class="endpoint">
              <span class="method post">POST</span>
              <strong>/api/chat</strong> - Chat with the AI agent
            </div>
            <div class="endpoint">
              <span class="method get">GET</span>
              <strong>/health</strong> - System health check
            </div>
            <div class="endpoint">
              <span class="method get">GET</span>
              <strong>/api/stats</strong> - System statistics
            </div>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/health', (req, res) => {
  const stats = agiAgent.getStats();
  res.json({
    status: 'healthy',
    service: 'advanced-agi-agent',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    database: dbConnected,
    providers: stats.providers.available,
    capabilities: stats.capabilities,
    performance: {
      requests: stats.requests,
      errors: stats.errorCount,
      errorRate: stats.errorRate,
      uptime: stats.uptime
    }
  });
});

// Enhanced chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, options = {} } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        error: 'Valid message string is required',
        code: 'INVALID_MESSAGE'
      });
    }
    
    const sessionId = req.session.id || crypto.randomUUID();
    if (!req.session.id) req.session.id = sessionId;
    
    // Process message
    const response = await agiAgent.processMessage(sessionId, message, options);
    
    res.json({
      response: response.content,
      provider: response.provider,
      model: response.model,
      confidence: response.confidence,
      processingTime: response.processingTime,
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Chat API error:', error);
    res.status(500).json({ 
      error: 'Chat processing failed',
      code: 'PROCESSING_ERROR',
      message: error.message
    });
  }
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  try {
    const stats = agiAgent.getStats();
    
    res.json({
      ...stats,
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        memory: process.memoryUsage()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Stats API error:', error);
    res.status(500).json({ error: 'Stats retrieval failed' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled request error:', error);
  
  res.status(error.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown handling
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  
  try {
    server.close(() => {
      logger.info('HTTP server closed');
    });
    
    if (pool) {
      await pool.end();
      logger.info('Database pool closed');
    }
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
    
  } catch (error) {
    logger.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    
    // Create necessary directories
    try {
      await fs.mkdir('logs', { recursive: true });
    } catch (error) {
      // Directory might already exist
    }
    
    // Start HTTP server
    server.listen(config.port, config.host, () => {
      logger.info(`🚀 Advanced AGI Agent v2.0 running on http://${config.host}:${config.port}`);
      logger.info(`💾 Database: ${dbConnected ? '✅ Connected' : '🟡 Memory Only'}`);
      logger.info(`🤖 AI Providers: ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ') || 'None configured'}`);
      logger.info(`🛠️  Tools: ${agiAgent.toolSystem.tools.size} registered`);
      logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
    
    logger.info('🎉 Advanced AGI Agent started successfully!');
    
  } catch (error) {
    logger.error('❌ Startup failed:', error);
    process.exit(1);
  }
}

// Export for testing
export default app;
export { agiAgent, config };

// Start the server
startServer();
