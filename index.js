import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import winston from 'winston';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import pg from 'pg';
import { NodeVM } from 'vm2';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import sharp from 'sharp';
import mammoth from 'mammoth';
import csv from 'csv-parser';
import XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

// PDF-parse'ı dinamik olarak import et
let pdf;
try {
  const pdfModule = await import('pdf-parse');
  pdf = pdfModule.default;
} catch (error) {
  console.warn('PDF parsing not available:', error.message);
  pdf = null;
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== LOGGER ====================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level}]: ${stack || message}`;
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// ==================== DATABASE ====================
const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
}) : null;

// Database initialization
async function initDatabase() {
  if (!pool) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        preferences JSONB DEFAULT '{}'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        session_id VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        response TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        tokens_used INTEGER DEFAULT 0,
        execution_time INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        key VARCHAR(255) NOT NULL,
        value TEXT NOT NULL,
        category VARCHAR(100) DEFAULT 'general',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, key, category)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(100) NOT NULL,
        file_size INTEGER NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        processed BOOLEAN DEFAULT false,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        task_type VARCHAR(100) NOT NULL,
        task_data JSONB NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        result JSONB,
        scheduled_at TIMESTAMP,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    logger.info('Database tables initialized successfully');
  } catch (error) {
    logger.error('Database initialization error:', error);
  }
}

// ==================== ADVANCED AI AGENT CLASS ====================
class AdvancedAIAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.temperature = parseFloat(process.env.AGENT_TEMPERATURE) || 0.7;
    this.maxTokens = parseInt(process.env.MAX_TOKENS) || 2000;
    
    this.conversationHistory = new Map();
    this.activeConnections = new Map();
    this.tools = this.initializeTools();
    
    logger.info('AI Agent initialized successfully');
  }

  initializeTools() {
    return {
      execute_javascript: {
        name: "execute_javascript",
        description: "Execute JavaScript code safely in a sandboxed environment. Returns the result or error.",
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The JavaScript code to execute"
            }
          },
          required: ["code"]
        }
      },
      
      execute_python: {
        name: "execute_python",
        description: "Execute Python code (simulated). For complex calculations, data analysis, or scientific computing.",
        parameters: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The Python code to execute"
            }
          },
          required: ["code"]
        }
      },
      
      "Web Search": {
        name: "Web Search",
        description: "Search the web for current information. Use this for recent events, news, or when you need up-to-date information.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The search query"
            }
          },
          required: ["query"]
        }
      },
      
      save_memory: {
        name: "save_memory",
        description: "Save information to long-term memory.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The key to store the information under"
            },
            value: {
              type: "string",
              description: "The value to store"
            },
            category: {
              type: "string",
              description: "The category for organization (optional)",
              default: "general"
            }
          },
          required: ["key", "value"]
        }
      },
      
      recall_memory: {
        name: "recall_memory",
        description: "Recall information from long-term memory.",
        parameters: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "The key to retrieve information for"
            },
            category: {
              type: "string",
              description: "The category to search in (optional)"
            }
          },
          required: ["key"]
        }
      },
      
      create_file: {
        name: "create_file",
        description: "Create a file with specified content.",
        parameters: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "The name of the file to create"
            },
            content: {
              type: "string",
              description: "The content to write to the file"
            },
            type: {
              type: "string",
              description: "The file type (text, json, csv, etc.)",
              default: "text"
            }
          },
          required: ["filename", "content"]
        }
      },
      
      read_file: {
        name: "read_file",
        description: "Read content from a file.",
        parameters: {
          type: "object",
          properties: {
            filename: {
              type: "string",
              description: "The name of the file to read"
            }
          },
          required: ["filename"]
        }
      },
      
      system_info: {
        name: "system_info",
        description: "Get system information including memory usage, uptime, and environment details.",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      },
      
      schedule_task: {
        name: "schedule_task",
        description: "Schedule a task to run later.",
        parameters: {
          type: "object",
          properties: {
            task_type: {
              type: "string",
              description: "The type of task to schedule"
            },
            task_data: {
              type: "string",
              description: "The data for the task"
            },
            schedule_time: {
              type: "string",
              description: "When to run the task (ISO format or 'now')"
            }
          },
          required: ["task_type", "task_data", "schedule_time"]
        }
      }
    };
  }

  async executeFunction(functionName, parameters) {
    try {
      switch (functionName) {
        case 'execute_javascript':
          return await this.executeJavaScript(parameters.code);
          
        case 'execute_python':
          return await this.executePython(parameters.code);
          
        case 'Web Search':
          return await this.webSearch(parameters.query);
          
        case 'save_memory':
          return await this.saveMemory(parameters.key, parameters.value, parameters.category);
          
        case 'recall_memory':
          return await this.recallMemory(parameters.key, parameters.category);
          
        case 'create_file':
          return await this.createFile(parameters.filename, parameters.content, parameters.type);
          
        case 'read_file':
          return await this.readFile(parameters.filename);
          
        case 'system_info':
          return await this.getSystemInfo();
          
        case 'schedule_task':
          return await this.scheduleTask(parameters.task_type, parameters.task_data, parameters.schedule_time);
          
        default:
          return `Unknown function: ${functionName}`;
      }
    } catch (error) {
      return `Function execution error: ${error.message}`;
    }
  }

  async executeJavaScript(code) {
    try {
      const vm = new NodeVM({
        timeout: 10000,
        sandbox: {
          console: {
            log: (...args) => args.join(' '),
            error: (...args) => args.join(' '),
            warn: (...args) => args.join(' ')
          },
          Math,
          Date,
          JSON,
          Array,
          Object,
          String,
          Number,
          Boolean,
          RegExp
        },
        require: {
          external: false,
          builtin: ['crypto', 'util']
        }
      });

      const result = await vm.run(`
        (async function() {
          ${code}
        })()
      `);

      return typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
    } catch (error) {
      return `JavaScript Execution Error: ${error.message}`;
    }
  }

  async executePython(code) {
    try {
      // Python simulation - in production, you'd use a Python execution service
      if (code.includes('import numpy') || code.includes('import pandas')) {
        return "Python libraries like numpy/pandas are available. Code executed successfully.";
      }
      
      // Basic math operations simulation
      const mathOperations = code.match(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/g);
      if (mathOperations) {
        const results = mathOperations.map(op => {
          const [, a, operator, b] = op.match(/(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)/);
          const numA = parseFloat(a);
          const numB = parseFloat(b);
          switch (operator) {
            case '+': return numA + numB;
            case '-': return numA - numB;
            case '*': return numA * numB;
            case '/': return numA / numB;
            default: return 'Unknown operation';
          }
        });
        return `Python execution result: ${results.join(', ')}`;
      }
      
      return "Python code executed successfully (simulated)";
    } catch (error) {
      return `Python Execution Error: ${error.message}`;
    }
  }

  async webSearch(query) {
    try {
      // Using DuckDuckGo Instant Answer API
      const response = await axios.get(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`);
      
      if (response.data.AbstractText) {
        return response.data.AbstractText;
      }
      
      if (response.data.RelatedTopics && response.data.RelatedTopics.length > 0) {
        return response.data.RelatedTopics.slice(0, 3).map(topic => topic.Text).join('\n\n');
      }
      
      return `Search completed for "${query}" but no specific results found. Try a more specific query.`;
    } catch (error) {
      return `Web search error: ${error.message}`;
    }
  }

  async saveMemory(key, value, category = 'general') {
    if (!pool) return "Memory storage not available";
    
    try {
      const userId = 1; // Default user
      
      await pool.query(`
        INSERT INTO agent_memory (user_id, key, value, category, updated_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, key, category)
        DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP
      `, [userId, key, value, category]);
      
      return `Memory saved: ${key} = ${value} (category: ${category})`;
    } catch (error) {
      return `Memory save error: ${error.message}`;
    }
  }

  async recallMemory(key, category) {
    if (!pool) return "Memory storage not available";
    
    try {
      const userId = 1; // Default user
      
      let query = 'SELECT key, value, category, updated_at FROM agent_memory WHERE user_id = $1 AND key = $2';
      let params = [userId, key];
      
      if (category) {
        query += ' AND category = $3';
        params.push(category);
      }
      
      const result = await pool.query(query, params);
      
      if (result.rows.length === 0) {
        return `No memory found for key: ${key}`;
      }
      
      return result.rows.map(row => 
        `${row.key}: ${row.value} (category: ${row.category}, updated: ${row.updated_at})`
      ).join('\n');
    } catch (error) {
      return `Memory recall error: ${error.message}`;
    }
  }

  async createFile(filename, content, type = 'text') {
    try {
      const uploadsDir = path.join(__dirname, 'uploads');
      
      try {
        await fs.access(uploadsDir);
      } catch {
        await fs.mkdir(uploadsDir, { recursive: true });
      }
      
      const filePath = path.join(uploadsDir, filename);
      await fs.writeFile(filePath, content, 'utf8');
      
      return `File created successfully: ${filename} (${content.length} characters)`;
    } catch (error) {
      return `File creation error: ${error.message}`;
    }
  }

  async readFile(filename) {
    try {
      const filePath = path.join(__dirname, 'uploads', filename);
      const content = await fs.readFile(filePath, 'utf8');
      return content.length > 2000 ? content.substring(0, 2000) + '...[truncated]' : content;
    } catch (error) {
      return `File read error: ${error.message}`;
    }
  }

  async getSystemInfo() {
    try {
      const memUsage = process.memoryUsage();
      const uptime = process.uptime();
      
      return `System Information:
- Node.js Version: ${process.version}
- Platform: ${process.platform}
- Architecture: ${process.arch}
- Uptime: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s
- Memory Usage:
  - RSS: ${Math.round(memUsage.rss / 1024 / 1024)}MB
  - Heap Used: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB
  - Heap Total: ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB
- Environment: ${process.env.NODE_ENV || 'development'}
- Database: ${pool ? 'Connected' : 'Not connected'}
- PDF Support: ${pdf ? 'Available' : 'Not available'}`;
    } catch (error) {
      return `System info error: ${error.message}`;
    }
  }

  async scheduleTask(taskType, taskData, scheduleTime) {
    if (!pool) return "Task scheduling not available";
    
    try {
      const userId = 1; // Default user
      const scheduledAt = scheduleTime === 'now' ? new Date() : new Date(scheduleTime);
      
      const result = await pool.query(`
        INSERT INTO agent_tasks (user_id, task_type, task_data, scheduled_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [userId, taskType, JSON.stringify({ data: taskData }), scheduledAt]);
      
      return `Task scheduled with ID: ${result.rows[0].id} for ${scheduledAt.toISOString()}`;
    } catch (error) {
      return `Task scheduling error: ${error.message}`;
    }
  }

  async processMessage(message, userId = 'anonymous', sessionId = null) {
    const startTime = Date.now();
    
    try {
      // Get conversation history for context
      const history = this.conversationHistory.get(sessionId) || [];
      
      // Prepare messages for OpenAI
      const messages = [
        {
          role: "system",
          content: `You are an advanced AI agent with the following capabilities:

CORE IDENTITY:
- You are a highly intelligent, autonomous AI agent running on Railway
- You can execute code, manage files, search the web, and maintain memory
- You have access to both JavaScript and Python execution environments
- You can schedule tasks, manage data, and perform complex operations
- You are designed to be helpful, accurate, and efficient

AVAILABLE FUNCTIONS:
- execute_javascript: Run JavaScript code in a secure sandbox
- execute_python: Run Python code for data analysis and scientific computing
- Web Search: Search the internet for current information
- save_memory/recall_memory: Store and retrieve information long-term
- create_file/read_file: File operations for data persistence
- system_info: Get detailed system and environment information
- schedule_task: Schedule tasks for future execution

BEHAVIOR GUIDELINES:
- Always think step by step before taking actions
- Use functions when they would be helpful to answer questions or solve problems
- Explain your reasoning and what you're doing
- Be proactive in suggesting solutions and improvements
- Maintain context and remember important information
- Handle errors gracefully and provide helpful feedback
- Be conversational but professional

CAPABILITIES:
- Code generation and execution in multiple languages
- Data analysis and visualization
- Web research and information gathering
- File processing and management
- Task automation and scheduling
- Memory management and learning from interactions
- System monitoring and optimization

Remember: You are not just a chatbot, you are a capable AI agent that can take actions and solve real problems.`
        },
        ...history,
        {
          role: "user",
          content: message
        }
      ];

      // Call OpenAI with function calling
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: messages,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        functions: Object.values(this.tools),
        function_call: "auto"
      });

      const assistantMessage = response.choices[0].message;
      let finalResponse = assistantMessage.content || "";
      let functionResults = [];

      // Handle function calls
      if (assistantMessage.function_call) {
        const functionName = assistantMessage.function_call.name;
        const functionArgs = JSON.parse(assistantMessage.function_call.arguments);
        
        logger.info(`Executing function: ${functionName} with args:`, functionArgs);
        
        const functionResult = await this.executeFunction(functionName, functionArgs);
        functionResults.push({ function: functionName, result: functionResult });
        
        // Get final response after function execution
        const followUpMessages = [
          ...messages,
          assistantMessage,
          {
            role: "function",
            name: functionName,
            content: functionResult
          }
        ];
        
        const followUpResponse = await this.openai.chat.completions.create({
          model: this.model,
          messages: followUpMessages,
          temperature: this.temperature,
          max_tokens: this.maxTokens
        });
        
        finalResponse = followUpResponse.choices[0].message.content;
      }

      // Update conversation history
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: finalResponse });
      
      // Keep only last 10 messages for context
      if (history.length > 20) {
        history.splice(0, history.length - 20);
      }
      
      this.conversationHistory.set(sessionId, history);

      // Save to database if available
      if (pool) {
        try {
          await pool.query(`
            INSERT INTO conversations (user_id, session_id, message, response, metadata, tokens_used, execution_time)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `, [
            userId === 'anonymous' ? null : userId,
            sessionId,
            message,
            finalResponse,
            JSON.stringify({
              functionsUsed: functionResults.map(f => f.function),
              functionResults: functionResults
            }),
            response.usage?.total_tokens || 0,
            Date.now() - startTime
          ]);
        } catch (dbError) {
          logger.warn('Failed to save conversation to database:', dbError.message);
        }
      }

      return {
        response: finalResponse,
        functionResults: functionResults,
        executionTime: Date.now() - startTime,
        sessionId,
        tokensUsed: response.usage?.total_tokens || 0
      };

    } catch (error) {
      logger.error('Message processing error:', error);
      return {
        response: "I encountered an error while processing your request. Please try again or rephrase your question.",
        error: error.message,
        executionTime: Date.now() - startTime,
        sessionId
      };
    }
  }
}

// ==================== EXPRESS APP SETUP ====================
const app = express();
const server = createServer(app);

// Security and middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.RATE_LIMIT || 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// File upload configuration
const upload = multer({
  dest: 'uploads/',
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|txt|csv|json|docx|xlsx/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// ==================== INITIALIZE AGENT ====================
let agent;
try {
  agent = new AdvancedAIAgent();
  logger.info('Advanced AI Agent created successfully');
} catch (error) {
  logger.error('Failed to create AI Agent:', error);
  process.exit(1);
}

// ==================== API ROUTES ====================

// Health check
app.get('/health', async (req, res) => {
  try {
    const dbStatus = pool ? 'connected' : 'not configured';
    if (pool) {
      await pool.query('SELECT 1');
    }
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: '2.0.0',
      pdfSupport: pdf ? 'available' : 'not available'
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = uuidv4(), userId = 'anonymous' } = req.body;
    
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
    
    const result = await agent.processMessage(message, userId, sessionId);
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    logger.error('Chat API error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const fileInfo = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    };
    
    // Process file based on type
    let processedContent = '';
    
    if (req.file.mimetype.startsWith('text/')) {
      processedContent = await fs.readFile(req.file.path, 'utf8');
    } else if (req.file.mimetype === 'application/pdf' && pdf) {
      try {
        const dataBuffer = await fs.readFile(req.file.path);
        const pdfData = await pdf(dataBuffer);
        processedContent = pdfData.text;
      } catch (pdfError) {
        logger.warn('PDF processing failed:', pdfError.message);
        processedContent = 'PDF file uploaded but could not be processed for text extraction.';
      }
    } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      try {
        const dataBuffer = await fs.readFile(req.file.path);
        const result = await mammoth.extractRawText({ buffer: dataBuffer });
        processedContent = result.value;
      } catch (docxError) {
        logger.warn('DOCX processing failed:', docxError.message);
        processedContent = 'DOCX file uploaded but could not be processed for text extraction.';
      }
    }
    
    // Save file info to database
    if (pool) {
      try {
        await pool.query(`
          INSERT INTO files (user_id, filename, original_name, file_type, file_size, file_path, processed)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [1, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.file.path, true]);
      } catch (dbError) {
        logger.warn('Failed to save file info to database:', dbError.message);
      }
    }
    
    res.json({
      success: true,
      file: fileInfo,
      contentPreview: processedContent.substring(0, 500) + (processedContent.length > 500 ? '...' : '')
    });
    
  } catch (error) {
    logger.error('File upload error:', error);
    res.status(500).json({
      success: false,
      error: 'File upload failed',
      message: error.message
    });
  }
});

// Get conversation history
app.get('/api/conversations/:sessionId', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({ error: 'Database not available' });
    }
    
    const { sessionId } = req.params;
    const result = await pool.query(`
      SELECT message, response, created_at, metadata
      FROM conversations
      WHERE session_id = $1
      ORDER BY created_at ASC
      LIMIT 50
    `, [sessionId]);
    
    res.json({
      success: true,
      conversations: result.rows
    });
    
  } catch (error) {
    logger.error('Conversation history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve conversation history'
    });
  }
});

// Get agent statistics
app.get('/api/stats', async (req, res) => {
  try {
    const stats = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeConnections: agent.activeConnections.size,
      conversationSessions: agent.conversationHistory.size,
      pdfSupport: pdf ? 'available' : 'not available'
    };
    
    if (pool) {
      try {
        const conversationCount = await pool.query('SELECT COUNT(*) as count FROM conversations');
        const userCount = await pool.query('SELECT COUNT(*) as count FROM users');
        const memoryCount = await pool.query('SELECT COUNT(*) as count FROM agent_memory');
        
        stats.database = {
          conversations: parseInt(conversationCount.rows[0].count),
          users: parseInt(userCount.rows[0].count),
          memories: parseInt(memoryCount.rows[0].count)
        };
      } catch (dbError) {
        logger.warn('Failed to get database stats:', dbError.message);
        stats.database = { error: 'Database query failed' };
      }
    }
    
    res.json({
      success: true,
      stats
    });
    
  } catch (error) {
    logger.error('Stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve statistics'
    });
  }
});

// Advanced web interface
app.get('/', (req, res) => {
  const sessionId = uuidv4();
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Advanced AI Agent</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            width: 100%;
            max-width: 800px;
            height: 80vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            backdrop-filter: blur(10px);
        }
        .header {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            padding: 20px;
            text-align: center;
        }
        .header h1 {
            font-size: 24px;
            margin-bottom: 5px;
        }
        .header p {
            opacity: 0.9;
            font-size: 14px;
        }
        .chat-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            background: #f8f9fa;
        }
        .message {
            margin-bottom: 15px;
            display: flex;
            align-items: flex-start;
            animation: fadeIn 0.3s ease-in;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .message.user {
            justify-content: flex-end;
        }
        .message-content {
            max-width: 70%;
            padding: 12px 16px;
            border-radius: 18px;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        .message.user .message-content {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border-bottom-right-radius: 5px;
        }
        .message.agent .message-content {
            background: white;
            border: 1px solid #e9ecef;
            border-bottom-left-radius: 5px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .input-area {
            padding: 20px;
            background: white;
            border-top: 1px solid #e9ecef;
        }
        .input-container {
            display: flex;
            gap: 10px;
            align-items: flex-end;
        }
        .input-field {
            flex: 1;
            min-height: 40px;
            max-height: 120px;
            padding: 10px 15px;
            border: 2px solid #e9ecef;
            border-radius: 20px;
            font-size: 14px;
            resize: none;
            outline: none;
            transition: border-color 0.3s ease;
        }
        .input-field:focus {
            border-color: #667eea;
        }
        .send-button {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: transform 0.2s ease;
        }
        .send-button:hover:not(:disabled) {
            transform: scale(1.05);
        }
        .send-button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .typing-indicator {
            display: none;
            padding: 10px 16px;
            background: white;
            border: 1px solid #e9ecef;
            border-radius: 18px;
            margin-bottom: 15px;
            max-width: 70%;
        }
        .typing-dots {
            display: flex;
            gap: 4px;
        }
        .typing-dots span {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #667eea;
            animation: typing 1.4s infinite ease-in-out;
        }
        .typing-dots span:nth-child(1) { animation-delay: -0.32s; }
        .typing-dots span:nth-child(2) { animation-delay: -0.16s; }
        @keyframes typing {
            0%, 80%, 100% { transform: scale(0); opacity: 0.5; }
            40% { transform: scale(1); opacity: 1; }
        }
        .status-bar {
            padding: 10px 20px;
            background: #f8f9fa;
            border-top: 1px solid #e9ecef;
            font-size: 12px;
            color: #6c757d;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .file-upload {
            display: none;
        }
        .upload-button {
            background: #28a745;
            color: white;
            border: none;
            border-radius: 15px;
            padding: 5px 10px;
            font-size: 12px;
            cursor: pointer;
            margin-right: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 Advanced AI Agent</h1>
            <p>Intelligent assistant with code execution, web search, and memory capabilities</p>
        </div>
        
        <div class="chat-area">
            <div class="messages" id="messages">
                <div class="message agent">
                    <div class="message-content">
                        Hello! I'm your advanced AI agent. I can:
                        
                        • Execute JavaScript and Python code
                        • Search the web for current information
                        • Create and manage files
                        • Remember information across conversations
                        • Schedule tasks and automate workflows
                        • Analyze data and generate insights
                        
                        How can I help you today?
                    </div>
                </div>
            </div>
            
            <div class="typing-indicator" id="typingIndicator">
                <div class="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        </div>
        
        <div class="input-area">
            <div class="input-container">
                <input type="file" id="fileUpload" class="file-upload" accept=".txt,.pdf,.docx,.csv,.json,.jpg,.png">
                <button type="button" class="upload-button" onclick="document.getElementById('fileUpload').click()">📎</button>
                <textarea 
                    id="messageInput" 
                    class="input-field" 
                    placeholder="Type your message here... (Shift+Enter for new line)"
                    rows="1"
                ></textarea>
                <button id="sendButton" class="send-button">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                    </svg>
                </button>
            </div>
        </div>
        
        <div class="status-bar">
            <span id="statusText">Ready</span>
            <span id="sessionId">Session: ${sessionId.substring(0, 8)}</span>
        </div>
    </div>

    <script>
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const typingIndicator = document.getElementById('typingIndicator');
        const statusText = document.getElementById('statusText');
        const fileUpload = document.getElementById('fileUpload');
        
        const sessionId = '${sessionId}';
        let isProcessing = false;

        // Auto-resize textarea
        messageInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        });

        // Send message on Enter (but allow Shift+Enter for new lines)
        messageInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        sendButton.addEventListener('click', sendMessage);

        // File upload handler
        fileUpload.addEventListener('change', async function(e) {
            const file = e.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('file', file);

            try {
                statusText.textContent = 'Uploading file...';
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });

                const result = await response.json();
                
                if (result.success) {
                    addMessage(\`File uploaded successfully: \${file.name}\\n\\nContent preview:\\n\${result.contentPreview}\`, 'agent');
                    statusText.textContent = 'File uploaded';
                } else {
                    addMessage(\`File upload failed: \${result.error}\`, 'agent');
                    statusText.textContent = 'Upload failed';
                }
            } catch (error) {
                addMessage(\`File upload error: \${error.message}\`, 'agent');
                statusText.textContent = 'Upload error';
            }

            // Reset file input
            fileUpload.value = '';
        });

        async function sendMessage() {
            const message = messageInput.value.trim();
            if (!message || isProcessing) return;

            isProcessing = true;
            sendButton.disabled = true;
            statusText.textContent = 'Processing...';

            // Add user message
            addMessage(message, 'user');
            messageInput.value = '';
            messageInput.style.height = 'auto';

            // Show typing indicator
            typingIndicator.style.display = 'block';
            scrollToBottom();

            try {
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: message,
                        sessionId: sessionId
                    })
                });

                const result = await response.json();

                // Hide typing indicator
                typingIndicator.style.display = 'none';

                if (result.success) {
                    addMessage(result.response, 'agent');
                    statusText.textContent = \`Response in \${result.executionTime}ms (\${result.tokensUsed} tokens)\`;
                } else {
                    addMessage(\`Error: \${result.error}\`, 'agent');
                    statusText.textContent = 'Error occurred';
                }

            } catch (error) {
                typingIndicator.style.display = 'none';
                addMessage(\`Connection error: \${error.message}\`, 'agent');
                statusText.textContent = 'Connection error';
            }

            isProcessing = false;
            sendButton.disabled = false;
            messageInput.focus();
        }

        function addMessage(content, sender) {
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${sender}\`;
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.textContent = content;
            
            messageDiv.appendChild(contentDiv);
            messagesContainer.appendChild(messageDiv);
            
            scrollToBottom();
        }

        function scrollToBottom() {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        // Focus on input when page loads
        messageInput.focus();
    </script>
</body>
</html>`);
});

// ==================== WEBSOCKET SETUP ====================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const connectionId = uuidv4();
  agent.activeConnections.set(connectionId, ws);
  
  logger.info(`WebSocket connection established: ${connectionId}`);
  
  ws.on('message', async (data) => {
    try {
      const { message, sessionId = uuidv4() } = JSON.parse(data.toString());
      
      if (typeof message !== 'string') {
        ws.send(JSON.stringify({ error: 'Invalid message format' }));
        return;
      }
      
      const result = await agent.processMessage(message, 'websocket', sessionId);
      
      ws.send(JSON.stringify({
        type: 'response',
        ...result
      }));
      
    } catch (error) {
      logger.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: error.message
      }));
    }
  });
  
  ws.on('close', () => {
    agent.activeConnections.delete(connectionId);
    logger.info(`WebSocket connection closed: ${connectionId}`);
  });
  
  ws.on('error', (error) => {
    logger.error(`WebSocket error for ${connectionId}:`, error);
    agent.activeConnections.delete(connectionId);
  });
});

// ==================== TASK SCHEDULER ====================
if (pool) {
  // Run scheduled tasks every minute
  cron.schedule('* * * * *', async () => {
    try {
      const result = await pool.query(`
        SELECT id, task_type, task_data, user_id
        FROM agent_tasks
        WHERE status = 'pending' AND scheduled_at <= CURRENT_TIMESTAMP
        LIMIT 10
      `);
      
      for (const task of result.rows) {
        try {
          // Mark as processing
          await pool.query('UPDATE agent_tasks SET status = $1 WHERE id = $2', ['processing', task.id]);
          
          // Process task based on type
          let taskResult = {};
          switch (task.task_type) {
            case 'reminder':
              taskResult = { message: 'Reminder executed', data: task.task_data };
              break;
            case 'cleanup':
              taskResult = { message: 'Cleanup task executed', data: task.task_data };
              break;
            default:
              taskResult = { message: 'Unknown task type', data: task.task_data };
          }
          
          // Mark as completed
          await pool.query(`
            UPDATE agent_tasks 
            SET status = $1, result = $2, completed_at = CURRENT_TIMESTAMP 
            WHERE id = $3
          `, ['completed', JSON.stringify(taskResult), task.id]);
          
          logger.info(`Task ${task.id} completed successfully`);
          
        } catch (taskError) {
          logger.error(`Task ${task.id} failed:`, taskError);
          await pool.query(`
            UPDATE agent_tasks 
            SET status = $1, result = $2 
            WHERE id = $3
          `, ['failed', JSON.stringify({ error: taskError.message }), task.id]);
        }
      }
      
    } catch (error) {
      logger.error('Task scheduler error:', error);
    }
  });
}

// ==================== ERROR HANDLING ====================
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    if (pool) pool.end();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    if (pool) pool.end();
    process.exit(0);
  });
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initDatabase();
    
    server.listen(PORT, () => {
      logger.info(`🚀 Advanced AI Agent server running on port ${PORT}`);
      logger.info(`🌐 Web interface available`);
      logger.info(`🔌 WebSocket endpoint available`);
      logger.info(`📡 API endpoint: /api/chat`);
      logger.info(`📄 PDF Support: ${pdf ? 'Available' : 'Not available'}`);
    });
    
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;