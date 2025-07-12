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
    }),
    new winston.transports.File({ filename: 'logs/agent.log' })
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
    logger.warn('Database not configured');
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES conversations(session_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id SERIAL PRIMARY KEY,
        topic VARCHAR(255),
        content TEXT,
        source VARCHAR(255),
        confidence FLOAT,
        last_validated TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_actions (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(255),
        action_type VARCHAR(100),
        parameters JSONB,
        result JSONB,
        success BOOLEAN,
        duration_ms INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS learning_data (
        id SERIAL PRIMARY KEY,
        pattern_type VARCHAR(100),
        input_data JSONB,
        output_data JSONB,
        success_rate FLOAT,
        usage_count INTEGER DEFAULT 1,
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
  } : null,

  gemini: process.env.GEMINI_API_KEY ? {
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1'
  } : null
};

// Advanced Tools System
class ToolSystem extends EventEmitter {
  constructor() {
    super();
    this.tools = new Map();
    this.registerDefaultTools();
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
      
      // Log tool usage
      if (pool && dbConnected) {
        await pool.query(
          'INSERT INTO agent_actions (session_id, action_type, parameters, result, success, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)',
          [context.sessionId, `tool:${name}`, params, result, true, duration]
        );
      }

      this.emit('toolExecuted', { name, params, result, duration, success: true });
      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      
      if (pool && dbConnected) {
        await pool.query(
          'INSERT INTO agent_actions (session_id, action_type, parameters, result, success, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)',
          [context.sessionId, `tool:${name}`, params, { error: error.message }, false, duration]
        );
      }

      this.emit('toolExecuted', { name, params, error: error.message, duration, success: false });
      throw error;
    }
  }

  registerDefaultTools() {
    // Web Search Tool
    this.registerTool('web_search', {
      name: 'web_search',
      description: 'Search the web for information',
      parameters: {
        query: { type: 'string', required: true },
        maxResults: { type: 'number', default: 5 }
      },
      execute: async (params) => {
        // Implement web search using your preferred search API
        const searchResults = await this.performWebSearch(params.query, params.maxResults);
        return { results: searchResults };
      }
    });

    // Code Execution Tool
    this.registerTool('code_execute', {
      name: 'code_execute',
      description: 'Execute code in a sandboxed environment',
      parameters: {
        language: { type: 'string', required: true },
        code: { type: 'string', required: true }
      },
      execute: async (params) => {
        // Implement safe code execution
        return await this.executeCode(params.language, params.code);
      }
    });

    // Memory Tool
    this.registerTool('memory_store', {
      name: 'memory_store',
      description: 'Store information in long-term memory',
      parameters: {
        key: { type: 'string', required: true },
        value: { type: 'any', required: true },
        category: { type: 'string', default: 'general' }
      },
      execute: async (params, context) => {
        longTermCache.set(`${context.sessionId}:${params.key}`, params.value);
        return { stored: true };
      }
    });

    // Memory Retrieval Tool
    this.registerTool('memory_retrieve', {
      name: 'memory_retrieve',
      description: 'Retrieve information from long-term memory',
      parameters: {
        key: { type: 'string', required: true }
      },
      execute: async (params, context) => {
        const value = longTermCache.get(`${context.sessionId}:${params.key}`);
        return { value: value || null };
      }
    });

    // File System Tool
    this.registerTool('file_system', {
      name: 'file_system',
      description: 'Interact with file system',
      parameters: {
        action: { type: 'string', required: true }, // read, write, list
        path: { type: 'string', required: true },
        content: { type: 'string', required: false }
      },
      execute: async (params) => {
        return await this.fileSystemOperation(params);
      }
    });
  }

  async performWebSearch(query, maxResults = 5) {
    // Implement with your preferred search API (SerpAPI, Google Custom Search, etc.)
    // This is a placeholder implementation
    return [
      { title: 'Search Result 1', url: 'https://example.com/1', snippet: 'Result content...' },
      { title: 'Search Result 2', url: 'https://example.com/2', snippet: 'Result content...' }
    ];
  }

  async executeCode(language, code) {
    // Implement safe code execution with Docker or similar sandboxing
    // This is a placeholder implementation
    return {
      output: 'Code execution placeholder',
      exitCode: 0,
      language: language
    };
  }

  async fileSystemOperation(params) {
    // Implement safe file system operations
    const allowedPaths = ['/tmp', '/workspace'];
    // Add security checks here
    
    switch (params.action) {
      case 'read':
        try {
          const content = await fs.readFile(params.path, 'utf8');
          return { content, success: true };
        } catch (error) {
          return { error: error.message, success: false };
        }
      case 'write':
        try {
          await fs.writeFile(params.path, params.content);
          return { success: true };
        } catch (error) {
          return { error: error.message, success: false };
        }
      case 'list':
        try {
          const files = await fs.readdir(params.path);
          return { files, success: true };
        } catch (error) {
          return { error: error.message, success: false };
        }
      default:
        return { error: 'Invalid action', success: false };
    }
  }
}

// Advanced Memory Management with persistent storage
class AdvancedMemoryManager {
  constructor() {
    this.conversations = new Map();
    this.userProfiles = new Map();
    this.contextWindows = new Map();
    this.maxConversations = 10000;
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
          reasoning: row.reasoning,
          confidence: row.confidence_score,
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
    // Add to memory
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
    
    // Keep conversation length manageable
    if (conversation.length > this.maxMessages) {
      conversation.splice(0, conversation.length - this.maxMessages);
    }
    
    // Persist to database
    if (pool && dbConnected) {
      try {
        await pool.query(
          'INSERT INTO messages (session_id, role, content, metadata, reasoning, confidence_score) VALUES ($1, $2, $3, $4, $5, $6)',
          [sessionId, message.role, message.content, message.metadata || {}, message.reasoning || {}, message.confidence || 0.5]
        );
      } catch (error) {
        logger.error('Failed to save message:', error);
      }
    }
    
    return enhancedMessage;
  }

  async getUserProfile(sessionId) {
    if (this.userProfiles.has(sessionId)) {
      return this.userProfiles.get(sessionId);
    }

    if (pool && dbConnected) {
      try {
        const result = await pool.query(
          'SELECT user_profile FROM conversations WHERE session_id = $1',
          [sessionId]
        );
        
        if (result.rows.length > 0) {
          const profile = result.rows[0].user_profile || {};
          this.userProfiles.set(sessionId, profile);
          return profile;
        }
      } catch (error) {
        logger.error('Failed to load user profile:', error);
      }
    }

    return {};
  }

  async updateUserProfile(sessionId, profileData) {
    this.userProfiles.set(sessionId, profileData);
    
    if (pool && dbConnected) {
      try {
        await pool.query(
          'INSERT INTO conversations (session_id, user_profile) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET user_profile = $2, updated_at = CURRENT_TIMESTAMP',
          [sessionId, profileData]
        );
      } catch (error) {
        logger.error('Failed to update user profile:', error);
      }
    }
  }

  getContextWindow(sessionId, windowSize = 10) {
    const conversation = this.conversations.get(sessionId) || [];
    return conversation.slice(-windowSize);
  }

  async analyzeConversationPatterns(sessionId) {
    const conversation = this.conversations.get(sessionId) || [];
    
    // Analyze conversation patterns
    const patterns = {
      messageFrequency: this.calculateMessageFrequency(conversation),
      topicDiversity: this.calculateTopicDiversity(conversation),
      userBehavior: this.analyzeUserBehavior(conversation),
      preferredResponseStyle: this.analyzeResponseStyle(conversation)
    };

    return patterns;
  }

  calculateMessageFrequency(conversation) {
    // Implementation for message frequency analysis
    return conversation.length;
  }

  calculateTopicDiversity(conversation) {
    // Implementation for topic diversity analysis
    return 0.5; // Placeholder
  }

  analyzeUserBehavior(conversation) {
    // Implementation for user behavior analysis
    return {};
  }

  analyzeResponseStyle(conversation) {
    // Implementation for response style analysis
    return 'conversational';
  }
}

// Advanced Reasoning Engine
class ReasoningEngine {
  constructor() {
    this.reasoningMethods = {
      'deductive': this.deductiveReasoning,
      'inductive': this.inductiveReasoning,
      'abductive': this.abductiveReasoning,
      'analogical': this.analogicalReasoning,
      'causal': this.causalReasoning
    };
  }

  async reason(problem, context = {}, method = 'deductive') {
    const startTime = Date.now();
    
    try {
      const reasoningMethod = this.reasoningMethods[method];
      if (!reasoningMethod) {
        throw new Error(`Unknown reasoning method: ${method}`);
      }

      const result = await reasoningMethod.call(this, problem, context);
      const duration = Date.now() - startTime;
      
      return {
        conclusion: result.conclusion,
        steps: result.steps,
        confidence: result.confidence,
        method: method,
        duration: duration
      };
    } catch (error) {
      logger.error('Reasoning failed:', error);
      return {
        conclusion: 'Unable to reach conclusion',
        steps: [],
        confidence: 0,
        method: method,
        error: error.message
      };
    }
  }

  async deductiveReasoning(problem, context) {
    // Implementation of deductive reasoning
    return {
      conclusion: 'Deductive conclusion',
      steps: ['Step 1', 'Step 2', 'Step 3'],
      confidence: 0.8
    };
  }

  async inductiveReasoning(problem, context) {
    // Implementation of inductive reasoning
    return {
      conclusion: 'Inductive conclusion',
      steps: ['Observation 1', 'Observation 2', 'Pattern identified'],
      confidence: 0.7
    };
  }

  async abductiveReasoning(problem, context) {
    // Implementation of abductive reasoning
    return {
      conclusion: 'Best explanation',
      steps: ['Hypothesis 1', 'Hypothesis 2', 'Best fit selected'],
      confidence: 0.6
    };
  }

  async analogicalReasoning(problem, context) {
    // Implementation of analogical reasoning
    return {
      conclusion: 'Analogical conclusion',
      steps: ['Source domain', 'Target domain', 'Mapping'],
      confidence: 0.5
    };
  }

  async causalReasoning(problem, context) {
    // Implementation of causal reasoning
    return {
      conclusion: 'Causal conclusion',
      steps: ['Cause identification', 'Effect prediction', 'Causal chain'],
      confidence: 0.7
    };
  }
}

// Advanced Learning System
class LearningSystem {
  constructor() {
    this.patterns = new Map();
    this.successes = new Map();
    this.failures = new Map();
    this.adaptationRate = config.learningRate;
  }

  async learn(input, output, success, feedback = null) {
    const patternKey = this.generatePatternKey(input);
    
    if (!this.patterns.has(patternKey)) {
      this.patterns.set(patternKey, {
        input: input,
        outputs: [],
        successRate: 0,
        usageCount: 0
      });
    }

    const pattern = this.patterns.get(patternKey);
    pattern.outputs.push({ output, success, feedback, timestamp: Date.now() });
    pattern.usageCount++;
    
    // Calculate success rate
    const successCount = pattern.outputs.filter(o => o.success).length;
    pattern.successRate = successCount / pattern.outputs.length;
    
    // Store in database
    if (pool && dbConnected) {
      try {
        await pool.query(
          'INSERT INTO learning_data (pattern_type, input_data, output_data, success_rate, usage_count) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (pattern_type) DO UPDATE SET success_rate = $4, usage_count = $5',
          ['response_pattern', input, output, pattern.successRate, pattern.usageCount]
        );
      } catch (error) {
        logger.error('Failed to store learning data:', error);
      }
    }

    this.adapt(patternKey, success);
  }

  generatePatternKey(input) {
    // Generate a key based on input characteristics
    return crypto.createHash('md5').update(JSON.stringify(input)).digest('hex');
  }

  adapt(patternKey, success) {
    // Implement adaptation logic based on success/failure
    if (success) {
      this.successes.set(patternKey, (this.successes.get(patternKey) || 0) + 1);
    } else {
      this.failures.set(patternKey, (this.failures.get(patternKey) || 0) + 1);
    }
  }

  getBestStrategy(input) {
    const patternKey = this.generatePatternKey(input);
    const pattern = this.patterns.get(patternKey);
    
    if (pattern && pattern.successRate > 0.7) {
      return pattern.outputs
        .filter(o => o.success)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
    }
    
    return null;
  }
}

// Enhanced AGI Agent
class AdvancedAGIAgent extends EventEmitter {
  constructor() {
    super();
    this.memoryManager = new AdvancedMemoryManager();
    this.toolSystem = new ToolSystem();
    this.reasoningEngine = new ReasoningEngine();
    this.learningSystem = new LearningSystem();
    
    this.requestCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
    
    this.providerWeights = {
      openai: 1.0,
      deepseek: 0.8,
      anthropic: 0.95,
      gemini: 0.85
    };

    this.capabilities = {
      reasoning: true,
      learning: true,
      memory: true,
      tools: true,
      planning: true,
      multimodal: true
    };

    this.setupEventListeners();
  }

  setupEventListeners() {
    this.on('messageProcessed', (data) => {
      this.learningSystem.learn(data.input, data.output, data.success, data.feedback);
    });

    this.toolSystem.on('toolExecuted', (data) => {
      this.emit('toolUsed', data);
    });
  }

  async processMessage(sessionId, message, options = {}) {
    const startTime = Date.now();
    
    try {
      // Load conversation context
      await this.memoryManager.loadConversation(sessionId);
      const userProfile = await this.memoryManager.getUserProfile(sessionId);
      const conversationContext = this.memoryManager.getContextWindow(sessionId);
      
      // Analyze the message
      const analysis = await this.analyzeMessage(message, conversationContext, userProfile);
      
      // Determine if reasoning is needed
      let reasoning = null;
      if (analysis.requiresReasoning) {
        reasoning = await this.reasoningEngine.reason(
          analysis.problem,
          { sessionId, userProfile, context: conversationContext },
          analysis.reasoningMethod
        );
      }

      // Determine if tools are needed
      let toolResults = {};
      if (analysis.requiredTools && analysis.requiredTools.length > 0) {
        toolResults = await this.executeTools(analysis.requiredTools, { sessionId, userProfile });
      }

      // Generate response
      const response = await this.generateResponse(
        sessionId,
        message,
        conversationContext,
        userProfile,
        reasoning,
        toolResults,
        options
      );

      // Save to memory
      await this.memoryManager.saveMessage(sessionId, { 
        role: 'user', 
        content: message,
        metadata: { analysis, reasoning: reasoning?.method }
      });
      
      await this.memoryManager.saveMessage(sessionId, { 
        role: 'assistant', 
        content: response.content,
        metadata: { 
          provider: response.provider,
          model: response.model,
          confidence: response.confidence,
          toolsUsed: Object.keys(toolResults)
        },
        reasoning: reasoning,
        confidence: response.confidence
      });

      // Update user profile based on interaction
      await this.updateUserProfile(sessionId, message, response);

      const duration = Date.now() - startTime;
      this.requestCount++;

      const result = {
        ...response,
        reasoning: reasoning,
        toolsUsed: Object.keys(toolResults),
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
        content: "I encountered an error processing your message. Let me try to help you in a different way.",
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

  async analyzeMessage(message, context, userProfile) {
    // Analyze message to determine processing strategy
    const analysis = {
      intent: await this.classifyIntent(message),
      complexity: this.assessComplexity(message),
      requiresReasoning: this.needsReasoning(message),
      reasoningMethod: this.selectReasoningMethod(message),
      requiredTools: this.identifyRequiredTools(message),
      emotionalContext: this.analyzeEmotionalContext(message),
      userContext: this.analyzeUserContext(userProfile, context)
    };

    return analysis;
  }

  async classifyIntent(message) {
    // Classify the user's intent
    const intents = ['question', 'request', 'conversation', 'task', 'creative', 'analysis'];
    // Implementation would use NLP or ML model
    return 'question'; // Placeholder
  }

  assessComplexity(message) {
    // Assess message complexity on a scale of 1-10
    const wordCount = message.split(' ').length;
    const hasQuestions = message.includes('?');
    const hasMultipleParts = message.includes('and') || message.includes('also');
    
    let complexity = Math.min(wordCount / 10, 5);
    if (hasQuestions) complexity += 1;
    if (hasMultipleParts) complexity += 1;
    
    return Math.min(complexity, 10);
  }

  needsReasoning(message) {
    const reasoningKeywords = ['why', 'how', 'explain', 'analyze', 'compare', 'evaluate', 'solve'];
    return reasoningKeywords.some(keyword => message.toLowerCase().includes(keyword));
  }

  selectReasoningMethod(message) {
    // Select appropriate reasoning method based on message content
    if (message.includes('why') || message.includes('because')) return 'causal';
    if (message.includes('similar') || message.includes('like')) return 'analogical';
    if (message.includes('pattern') || message.includes('trend')) return 'inductive';
    return 'deductive';
  }

  identifyRequiredTools(message) {
    const tools = [];
    
    if (message.includes('search') || message.includes('find')) tools.push('web_search');
    if (message.includes('calculate') || message.includes('compute')) tools.push('calculator');
    if (message.includes('code') || message.includes('program')) tools.push('code_execute');
    if (message.includes('remember') || message.includes('save')) tools.push('memory_store');
    if (message.includes('file') || message.includes('document')) tools.push('file_system');
    
    return tools;
  }

  analyzeEmotionalContext(message) {
    // Simple emotional analysis
    const positiveWords = ['happy', 'good', 'great', 'excellent', 'wonderful'];
    const negativeWords = ['sad', 'bad', 'terrible', 'awful', 'frustrated'];
    
    const positive = positiveWords.some(word => message.toLowerCase().includes(word));
    const negative = negativeWords.some(word => message.toLowerCase().includes(word));
    
    if (positive) return 'positive';
    if (negative) return 'negative';
    return 'neutral';
  }

  analyzeUserContext(userProfile, context) {
    return {
      isNewUser: Object.keys(userProfile).length === 0,
      conversationLength: context.length,
      lastInteraction: context.length > 0 ? context[context.length - 1].timestamp : null
    };
  }

  async executeTools(tools, context) {
    const results = {};
    
    for (const toolName of tools) {
      try {
        const result = await this.toolSystem.executeTool(toolName, {}, context);
        results[toolName] = result;
      } catch (error) {
        logger.error(`Tool ${toolName} failed:`, error);
        results[toolName] = { error: error.message };
      }
    }
    
    return results;
  }

  async generateResponse(sessionId, message, context, userProfile, reasoning, toolResults, options = {}) {
    // Build enhanced context for AI providers
    const enhancedContext = this.buildEnhancedContext(message, context, userProfile, reasoning, toolResults);
    
    // Select best provider based on current performance
    const provider = this.selectBestProvider(enhancedContext);
    
    // Generate response using selected provider
    const response = await this.callAI(provider, enhancedContext.messages, {
      ...options,
      temperature: this.calculateOptimalTemperature(enhancedContext),
      maxTokens: options.maxTokens || config.maxTokens
    });

    // Calculate confidence score
    const confidence = this.calculateConfidence(response, enhancedContext, reasoning, toolResults);
    
    return {
      ...response,
      confidence: confidence,
      sessionId: sessionId
    };
  }

  buildEnhancedContext(message, context, userProfile, reasoning, toolResults) {
    const systemPrompt = this.buildSystemPrompt(userProfile, reasoning, toolResults);
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...context.map(msg => ({
        role: msg.role,
        content: msg.content
      })),
      { role: 'user', content: message }
    ];

    return {
      messages,
      userProfile,
      reasoning,
      toolResults,
      contextLength: context.length
    };
  }

  buildSystemPrompt(userProfile, reasoning, toolResults) {
    let prompt = `You are an advanced AGI assistant with the following capabilities:
- Advanced reasoning and analysis
- Long-term memory and context awareness
- Tool usage and integration
- Personalized responses based on user profile
- Learning from interactions

Current session context:`;

    if (Object.keys(userProfile).length > 0) {
      prompt += `\nUser Profile: ${JSON.stringify(userProfile, null, 2)}`;
    }

    if (reasoning) {
      prompt += `\nReasoning Analysis: ${reasoning.method} reasoning was applied.
Conclusion: ${reasoning.conclusion}
Confidence: ${reasoning.confidence}`;
    }

    if (Object.keys(toolResults).length > 0) {
      prompt += `\nTool Results: ${JSON.stringify(toolResults, null, 2)}`;
    }

    prompt += `\n\nPlease provide helpful, accurate, and personalized responses. Use the reasoning analysis and tool results to enhance your response quality.`;

    return prompt;
  }

  selectBestProvider(context) {
    // Select provider based on context and current performance
    const availableProviders = Object.keys(aiProviders).filter(p => aiProviders[p]);
    
    if (context.reasoning && context.reasoning.method === 'deductive') {
      return availableProviders.includes('anthropic') ? 'anthropic' : availableProviders[0];
    }
    
    if (context.toolResults && Object.keys(context.toolResults).length > 0) {
      return availableProviders.includes('openai') ? 'openai' : availableProviders[0];
    }
    
    // Default selection based on weights
    const weightedProviders = availableProviders.sort((a, b) => 
      this.providerWeights[b] - this.providerWeights[a]
    );
    
    return weightedProviders[0] || 'openai';
  }

  calculateOptimalTemperature(context) {
    let temperature = 0.7; // Default
    
    if (context.reasoning) {
      temperature = 0.3; // Lower for analytical tasks
    }
    
    if (context.userProfile.preferredStyle === 'creative') {
      temperature = 0.9; // Higher for creative tasks
    }
    
    return Math.max(0.1, Math.min(1.0, temperature));
  }

  calculateConfidence(response, context, reasoning, toolResults) {
    let confidence = 0.5; // Base confidence
    
    // Increase confidence based on reasoning
    if (reasoning && reasoning.confidence > 0.7) {
      confidence += 0.2;
    }
    
    // Increase confidence based on tool usage
    if (Object.keys(toolResults).length > 0) {
      confidence += 0.1;
    }
    
    // Adjust based on context length
    if (context.contextLength > 5) {
      confidence += 0.1;
    }
    
    // Adjust based on response length and coherence
    if (response.content && response.content.length > 100) {
      confidence += 0.1;
    }
    
    return Math.max(0.1, Math.min(1.0, confidence));
  }

  async updateUserProfile(sessionId, message, response) {
    const currentProfile = await this.memoryManager.getUserProfile(sessionId);
    
    // Extract user preferences and characteristics
    const updates = {};
    
    // Analyze communication style
    if (message.length > 200) {
      updates.communicationStyle = 'detailed';
    } else if (message.length < 50) {
      updates.communicationStyle = 'concise';
    }
    
    // Track interests based on topics
    const topics = this.extractTopics(message);
    if (topics.length > 0) {
      updates.interests = [...(currentProfile.interests || []), ...topics];
      updates.interests = [...new Set(updates.interests)]; // Remove duplicates
    }
    
    // Track preferred response length
    if (response.content) {
      updates.preferredResponseLength = response.content.length;
    }
    
    // Update interaction count
    updates.interactionCount = (currentProfile.interactionCount || 0) + 1;
    updates.lastInteraction = new Date().toISOString();
    
    const updatedProfile = { ...currentProfile, ...updates };
    await this.memoryManager.updateUserProfile(sessionId, updatedProfile);
  }

  extractTopics(message) {
    // Simple topic extraction - in production, use more sophisticated NLP
    const topicKeywords = {
      'technology': ['AI', 'computer', 'programming', 'software', 'tech'],
      'science': ['research', 'study', 'experiment', 'theory', 'science'],
      'business': ['company', 'market', 'finance', 'strategy', 'business'],
      'health': ['health', 'medical', 'doctor', 'wellness', 'fitness'],
      'education': ['learn', 'study', 'school', 'education', 'knowledge']
    };
    
    const topics = [];
    const messageLower = message.toLowerCase();
    
    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some(keyword => messageLower.includes(keyword))) {
        topics.push(topic);
      }
    }
    
    return topics;
  }

  async callAI(providers, messages, options = {}) {
    const providerList = Array.isArray(providers) ? providers : [providers];
    const availableProviders = providerList.filter(p => aiProviders[p]);

    if (availableProviders.length === 0) {
      throw new Error('No AI providers available');
    }

    const cacheKey = `ai_${crypto.createHash('md5').update(JSON.stringify({ messages, options })).digest('hex')}`;
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
          case 'gemini':
            result = await this.callGemini(messages, options);
            break;
        }
        
        cache.set(cacheKey, result, 1800); // Cache for 30 minutes
        this.requestCount++;
        
        // Update provider weights based on success
        this.updateProviderWeight(provider, true);
        
        return result;
        
      } catch (error) {
        this.errorCount++;
        this.updateProviderWeight(provider, false);
        logger.warn(`Provider ${provider} failed:`, error.message);
      }
    }
    
    throw new Error('All AI providers failed');
  }

  updateProviderWeight(provider, success) {
    const adjustment = success ? 0.01 : -0.02;
    this.providerWeights[provider] = Math.max(0.1, Math.min(1.0, 
      this.providerWeights[provider] + adjustment
    ));
  }

  async callOpenAI(messages, options = {}) {
    if (!aiProviders.openai) throw new Error('OpenAI not configured');
    
    const response = await aiProviders.openai.chat.completions.create({
      model: options.model || 'gpt-4o',
      messages,
      max_tokens: options.maxTokens || config.maxTokens,
      temperature: options.temperature || 0.7,
      presence_penalty: 0.1,
      frequency_penalty: 0.1
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
      provider: 'anthropic',
      finishReason: response.data.stop_reason
    };
  }

  async callGemini(messages, options = {}) {
    if (!aiProviders.gemini) throw new Error('Gemini not configured');
    
    // Convert messages to Gemini format
    const geminiMessages = messages.filter(m => m.role !== 'system').map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
    
    const response = await axios.post(
      `${aiProviders.gemini.baseURL}/models/gemini-pro:generateContent?key=${aiProviders.gemini.apiKey}`,
      {
        contents: geminiMessages,
        generationConfig: {
          temperature: options.temperature || 0.7,
          maxOutputTokens: options.maxTokens || config.maxTokens
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
      }
    );
    
    return {
      content: response.data.candidates[0].content.parts[0].text,
      usage: response.data.usageMetadata,
      model: 'gemini-pro',
      provider: 'gemini',
      finishReason: response.data.candidates[0].finishReason
    };
  }

  async planTask(task, context = {}) {
    // Advanced task planning capability
    const plan = {
      task: task,
      steps: [],
      estimatedTime: 0,
      requiredTools: [],
      dependencies: [],
      priority: 'normal'
    };

    // Analyze task complexity
    const complexity = this.assessTaskComplexity(task);
    
    // Break down task into steps
    const steps = await this.decomposeTask(task, complexity);
    plan.steps = steps;
    
    // Estimate time and resources
    plan.estimatedTime = this.estimateTaskTime(steps);
    plan.requiredTools = this.identifyTaskTools(steps);
    
    return plan;
  }

  assessTaskComplexity(task) {
    // Assess task complexity (1-10 scale)
    const indicators = {
      multiStep: task.includes('and') || task.includes('then') ? 2 : 0,
      research: task.includes('research') || task.includes('analyze') ? 3 : 0,
      creation: task.includes('create') || task.includes('build') ? 2 : 0,
      calculation: task.includes('calculate') || task.includes('compute') ? 1 : 0
    };
    
    return Math.min(10, Object.values(indicators).reduce((sum, val) => sum + val, 1));
  }

  async decomposeTask(task, complexity) {
    // Decompose task into manageable steps
    const steps = [];
    
    if (complexity > 5) {
      // Complex task - break down further
      steps.push('Analyze requirements');
      steps.push('Gather necessary information');
      steps.push('Plan approach');
      steps.push('Execute main task');
      steps.push('Review and validate results');
    } else {
      // Simple task
      steps.push('Understand requirements');
      steps.push('Execute task');
      steps.push('Provide results');
    }
    
    return steps;
  }

  estimateTaskTime(steps) {
    // Estimate time in seconds
    return steps.length * 30; // 30 seconds per step average
  }

  identifyTaskTools(steps) {
    // Identify required tools based on steps
    const tools = new Set();
    
    steps.forEach(step => {
      if (step.includes('information') || step.includes('research')) {
        tools.add('web_search');
      }
      if (step.includes('calculate') || step.includes('compute')) {
        tools.add('calculator');
      }
      if (step.includes('code') || step.includes('program')) {
        tools.add('code_execute');
      }
    });
    
    return Array.from(tools);
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
        available: Object.keys(aiProviders).filter(p => aiProviders[p]),
        weights: this.providerWeights
      },
      tools: {
        registered: this.toolSystem.tools.size,
        available: Array.from(this.toolSystem.tools.keys())
      },
      learning: {
        patterns: this.learningSystem.patterns.size,
        adaptationRate: this.learningSystem.adaptationRate
      },
      cache: {
        shortTerm: cache.getStats(),
        longTerm: longTermCache.getStats()
      }
    };
  }

  async shutdown() {
    logger.info('AGI Agent shutting down...');
    
    // Save important data
    if (pool && dbConnected) {
      await pool.end();
    }
    
    // Clear caches
    cache.close();
    longTermCache.close();
    
    this.emit('shutdown');
  }
}

// Initialize enhanced system
const agiAgent = new AdvancedAGIAgent();
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
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', 
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
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Rate limiting middleware
const requestCounts = new Map();
const rateLimit = (req, res, next) => {
  const clientId = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 60; // 60 requests per minute
  
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

// Enhanced routes
app.get('/', async (req, res) => {
  try {
    const stats = agiAgent.getStats();
    const htmlPath = join(__dirname, 'advanced_ai_agent_interface.html');
    
    try {
      const html = await fs.readFile(htmlPath, 'utf8');
      res.send(html);
    } catch {
      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Advanced AGI Agent</title>
          <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
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
            .method.ws { background: #6f42c1; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🧠 Advanced AGI Agent</h1>
              <p>Next-generation AI assistant with reasoning, memory, and tool capabilities</p>
            </div>
            
            <div class="stats-grid">
              <div class="stat-card">
                <div class="stat-title">System Status</div>
                <div class="stat-value">✅ Online</div>
                <div>Database: ${dbConnected ? '🟢 Connected' : '🔴 Disconnected'}</div>
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
                <div>${stats.providers.available.join(', ')}</div>
              </div>
              
              <div class="stat-card">
                <div class="stat-title">Capabilities</div>
                <div class="stat-value">${Object.keys(stats.capabilities).length} modules</div>
                <div>Tools: ${stats.tools.registered}</div>
                <div>Learning Patterns: ${stats.learning.patterns}</div>
              </div>
            </div>
            
            <div class="endpoints">
              <h2>API Endpoints</h2>
              <div class="endpoint">
                <span class="method post">POST</span>
                <strong>/api/chat</strong> - Advanced chat with reasoning and memory
              </div>
              <div class="endpoint">
                <span class="method post">POST</span>
                <strong>/api/plan</strong> - Task planning and decomposition
              </div>
              <div class="endpoint">
                <span class="method post">POST</span>
                <strong>/api/learn</strong> - Submit learning feedback
              </div>
              <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/stats</strong> - Detailed system statistics
              </div>
              <div class="endpoint">
                <span class="method get">GET</span>
                <strong>/api/conversation/:id</strong> - Get conversation history
              </div>
              <div class="endpoint">
                <span class="method ws">WS</span>
                <strong>/ws</strong> - Real-time WebSocket connection
              </div>
            </div>
          </div>
        </body>
        </html>
      `);
    }
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
      errors: stats.errors,
      errorRate: stats.errorRate,
      uptime: stats.uptime
    }
  });
});

// Enhanced chat endpoint with full AGI capabilities
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
    
    // Process message with full AGI capabilities
    const response = await agiAgent.processMessage(sessionId, message, options);
    
    res.json({
      response: response.content,
      provider: response.provider,
      model: response.model,
      confidence: response.confidence,
      reasoning: response.reasoning,
      toolsUsed: response.toolsUsed,
      processingTime: response.processingTime,
      sessionId: sessionId,
      messageId: response.messageId || null,
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

// Task planning endpoint
app.post('/api/plan', async (req, res) => {
  try {
    const { task, context = {} } = req.body;
    
    if (!task) {
      return res.status(400).json({ error: 'Task description is required' });
    }
    
    const plan = await agiAgent.planTask(task, context);
    
    res.json({
      plan: plan,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Planning API error:', error);
    res.status(500).json({ error: 'Task planning failed' });
  }
});

// Learning feedback endpoint
app.post('/api/learn', async (req, res) => {
  try {
    const { messageId, sessionId, feedback, rating } = req.body;
    
    await agiAgent.learningSystem.learn(
      { messageId, sessionId },
      feedback,
      rating > 3,
      { rating, feedback }
    );
    
    res.json({ success: true });
    
  } catch (error) {
    logger.error('Learning API error:', error);
    res.status(500).json({ error: 'Learning feedback failed' });
  }
});

// Conversation history endpoint
app.get('/api/conversation/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const conversation = await agiAgent.memoryManager.loadConversation(sessionId);
    
    res.json({
      sessionId: sessionId,
      messages: conversation,
      messageCount: conversation.length
    });
    
  } catch (error) {
    logger.error('Conversation API error:', error);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// Enhanced stats endpoint
app.get('/api/stats', (req, res) => {
  try {
    const stats = agiAgent.getStats();
    
    res.json({
      ...stats,
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Stats API error:', error);
    res.status(500).json({ error: 'Stats retrieval failed' });
  }
});

// Enhanced WebSocket with full capabilities
const wss = new WebSocketServer({ 
  server, 
  path: '/ws',
  perMessageDeflate: false
});

wss.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  const clientIp = req.socket.remoteAddress;
  
  logger.info(`WebSocket connected: ${sessionId} from ${clientIp}`);

  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to Advanced AGI Agent',
    sessionId: sessionId,
    capabilities: agiAgent.capabilities,
    timestamp: new Date().toISOString()
  }));

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'chat':
          const response = await agiAgent.processMessage(sessionId, message.content, message.options || {});
          
          ws.send(JSON.stringify({
            type: 'chat_response',
            content: response.content,
            provider: response.provider,
            model: response.model,
            confidence: response.confidence,
            reasoning: response.reasoning,
            toolsUsed: response.toolsUsed,
            processingTime: response.processingTime,
            timestamp: new Date().toISOString()
          }));
          break;
          
        case 'plan':
          const plan = await agiAgent.planTask(message.task, { sessionId });
          
          ws.send(JSON.stringify({
            type: 'plan_response',
            plan: plan,
            timestamp: new Date().toISOString()
          }));
          break;
          
        case 'stats':
          const stats = agiAgent.getStats();
          
          ws.send(JSON.stringify({
            type: 'stats_response',
            stats: stats,
            timestamp: new Date().toISOString()
          }));
          break;
          
        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Unknown message type',
            timestamp: new Date().toISOString()
          }));
      }
    } catch (error) {
      logger.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Message processing failed',
        error: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  });

  ws.on('close', () => {
    logger.info(`WebSocket disconnected: ${sessionId}`);
  });

  ws.on('error', (error) => {
    logger.error(`WebSocket error for ${sessionId}:`, error);
  });
});

// Tool management endpoints
app.get('/api/tools', (req, res) => {
  try {
    const tools = Array.from(agiAgent.toolSystem.tools.entries()).map(([name, tool]) => ({
      name: name,
      description: tool.description || 'No description available',
      parameters: tool.parameters || {}
    }));
    
    res.json({
      tools: tools,
      count: tools.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Tools API error:', error);
    res.status(500).json({ error: 'Failed to retrieve tools' });
  }
});

app.post('/api/tools/:toolName/execute', async (req, res) => {
  try {
    const { toolName } = req.params;
    const { parameters = {}, context = {} } = req.body;
    
    const sessionId = req.session.id || crypto.randomUUID();
    if (!req.session.id) req.session.id = sessionId;
    
    const result = await agiAgent.toolSystem.executeTool(toolName, parameters, {
      ...context,
      sessionId: sessionId
    });
    
    res.json({
      tool: toolName,
      result: result,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Tool execution error:', error);
    res.status(500).json({ 
      error: 'Tool execution failed',
      message: error.message
    });
  }
});

// Memory management endpoints
app.get('/api/memory/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const profile = await agiAgent.memoryManager.getUserProfile(sessionId);
    const patterns = await agiAgent.memoryManager.analyzeConversationPatterns(sessionId);
    
    res.json({
      sessionId: sessionId,
      userProfile: profile,
      conversationPatterns: patterns,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Memory API error:', error);
    res.status(500).json({ error: 'Memory retrieval failed' });
  }
});

app.post('/api/memory/:sessionId/clear', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Clear conversation memory
    agiAgent.memoryManager.conversations.delete(sessionId);
    agiAgent.memoryManager.userProfiles.delete(sessionId);
    
    // Clear from database if connected
    if (pool && dbConnected) {
      await pool.query('DELETE FROM messages WHERE session_id = $1', [sessionId]);
      await pool.query('DELETE FROM conversations WHERE session_id = $1', [sessionId]);
    }
    
    res.json({
      success: true,
      message: 'Memory cleared for session',
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Memory clear error:', error);
    res.status(500).json({ error: 'Memory clear failed' });
  }
});

// Learning and analytics endpoints
app.get('/api/analytics', async (req, res) => {
  try {
    const stats = agiAgent.getStats();
    
    let dbAnalytics = {};
    if (pool && dbConnected) {
      const queries = await Promise.allSettled([
        pool.query('SELECT COUNT(*) as total_messages FROM messages'),
        pool.query('SELECT COUNT(DISTINCT session_id) as unique_sessions FROM conversations'),
        pool.query('SELECT provider, COUNT(*) as usage_count FROM messages WHERE metadata ? \'provider\' GROUP BY provider'),
        pool.query('SELECT DATE(created_at) as date, COUNT(*) as messages FROM messages WHERE created_at > NOW() - INTERVAL \'7 days\' GROUP BY DATE(created_at) ORDER BY date'),
        pool.query('SELECT AVG(confidence_score) as avg_confidence FROM messages WHERE confidence_score IS NOT NULL')
      ]);
      
      dbAnalytics = {
        totalMessages: queries[0].status === 'fulfilled' ? queries[0].value.rows[0]?.total_messages : 0,
        uniqueSessions: queries[1].status === 'fulfilled' ? queries[1].value.rows[0]?.unique_sessions : 0,
        providerUsage: queries[2].status === 'fulfilled' ? queries[2].value.rows : [],
        dailyActivity: queries[3].status === 'fulfilled' ? queries[3].value.rows : [],
        averageConfidence: queries[4].status === 'fulfilled' ? queries[4].value.rows[0]?.avg_confidence : 0
      };
    }
    
    res.json({
      systemStats: stats,
      analytics: dbAnalytics,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Analytics API error:', error);
    res.status(500).json({ error: 'Analytics retrieval failed' });
  }
});

// Configuration endpoints
app.get('/api/config', (req, res) => {
  try {
    res.json({
      maxTokens: config.maxTokens,
      defaultModel: config.defaultModel,
      maxConversationLength: config.maxConversationLength,
      reasoningDepth: config.reasoningDepth,
      toolTimeout: config.toolTimeout,
      learningRate: config.learningRate,
      capabilities: agiAgent.capabilities,
      availableProviders: Object.keys(aiProviders).filter(p => aiProviders[p]),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Config API error:', error);
    res.status(500).json({ error: 'Configuration retrieval failed' });
  }
});

app.post('/api/config', (req, res) => {
  try {
    const { maxTokens, reasoningDepth, toolTimeout, learningRate } = req.body;
    
    if (maxTokens && maxTokens > 0 && maxTokens <= 32000) {
      config.maxTokens = maxTokens;
    }
    
    if (reasoningDepth && reasoningDepth > 0 && reasoningDepth <= 10) {
      config.reasoningDepth = reasoningDepth;
    }
    
    if (toolTimeout && toolTimeout > 0 && toolTimeout <= 300000) {
      config.toolTimeout = toolTimeout;
    }
    
    if (learningRate && learningRate > 0 && learningRate <= 1) {
      config.learningRate = learningRate;
      agiAgent.learningSystem.adaptationRate = learningRate;
    }
    
    res.json({
      success: true,
      message: 'Configuration updated',
      newConfig: {
        maxTokens: config.maxTokens,
        reasoningDepth: config.reasoningDepth,
        toolTimeout: config.toolTimeout,
        learningRate: config.learningRate
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Config update error:', error);
    res.status(500).json({ error: 'Configuration update failed' });
  }
});

// Export/Import endpoints for data portability
app.get('/api/export/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { format = 'json' } = req.query;
    
    const conversation = await agiAgent.memoryManager.loadConversation(sessionId);
    const profile = await agiAgent.memoryManager.getUserProfile(sessionId);
    const patterns = await agiAgent.memoryManager.analyzeConversationPatterns(sessionId);
    
    const exportData = {
      sessionId: sessionId,
      exportDate: new Date().toISOString(),
      conversation: conversation,
      userProfile: profile,
      patterns: patterns,
      metadata: {
        version: '2.0.0',
        messageCount: conversation.length
      }
    };
    
    if (format === 'csv') {
      // Convert to CSV format
      const csv = conversation.map(msg => 
        `"${msg.timestamp}","${msg.role}","${msg.content.replace(/"/g, '""')}","${msg.confidence || ''}"`
      ).join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="conversation_${sessionId}.csv"`);
      res.send(`"Timestamp","Role","Content","Confidence"\n${csv}`);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="conversation_${sessionId}.json"`);
      res.json(exportData);
    }
    
  } catch (error) {
    logger.error('Export error:', error);
    res.status(500).json({ error: 'Export failed' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled request error:', error);
  
  res.status(error.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
    timestamp: new Date().toISOString(),
    requestId: crypto.randomUUID()
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
    // Close WebSocket server
    wss.close(() => {
      logger.info('WebSocket server closed');
    });
    
    // Close HTTP server
    server.close(() => {
      logger.info('HTTP server closed');
    });
    
    // Shutdown AGI agent
    await agiAgent.shutdown();
    
    // Close database pool
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

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// Health monitoring
setInterval(() => {
  const stats = agiAgent.getStats();
  const memoryUsage = process.memoryUsage();
  
  // Log health metrics
  logger.info('Health check:', {
    uptime: stats.uptime,
    requests: stats.requests,
    errors: stats.errors,
    memory: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
    activeConversations: stats.activeConversations
  });
  
  // Cleanup old data if memory usage is high
  if (memoryUsage.heapUsed > 500 * 1024 * 1024) { // 500MB
    logger.warn('High memory usage detected, cleaning up...');
    
    // Clear old cache entries
    cache.flushAll();
    
    // Clear old conversations (keep last 100)
    if (agiAgent.memoryManager.conversations.size > 100) {
      const entries = Array.from(agiAgent.memoryManager.conversations.entries());
      entries.slice(0, entries.length - 100).forEach(([key]) => {
        agiAgent.memoryManager.conversations.delete(key);
      });
    }
  }
}, 60000); // Every minute

// Performance monitoring
agiAgent.on('messageProcessed', (data) => {
  if (data.duration > 10000) { // More than 10 seconds
    logger.warn('Slow response detected:', {
      duration: data.duration,
      sessionId: data.sessionId,
      success: data.success
    });
  }
});

agiAgent.on('toolUsed', (data) => {
  if (!data.success) {
    logger.warn('Tool execution failed:', {
      tool: data.name,
      error: data.error,
      duration: data.duration
    });
  }
});

// Start the enhanced server
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();
    
    // Create necessary directories
    await fs.mkdir('logs', { recursive: true });
    await fs.mkdir('tmp', { recursive: true });
    
    // Start HTTP server
    server.listen(config.port, config.host, () => {
      logger.info(`🚀 Advanced AGI Agent v2.0 running on http://${config.host}:${config.port}`);
      logger.info(`💾 Database: ${dbConnected ? '✅ Connected' : '❌ Disconnected'}`);
      logger.info(`🤖 AI Providers: ${Object.keys(aiProviders).filter(p => aiProviders[p]).join(', ')}`);
      logger.info(`🛠️  Tools: ${agiAgent.toolSystem.tools.size} registered`);
      logger.info(`🧠 Capabilities: ${Object.keys(agiAgent.capabilities).filter(k => agiAgent.capabilities[k]).join(', ')}`);
      logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
    
    // Log startup success
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
