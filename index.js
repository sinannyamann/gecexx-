import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';

// Gelişmiş AI Sistemi
class PersonalAI extends EventEmitter {
  constructor() {
    super();
    this.memory = new Map();
    this.userProfiles = new Map();
    this.conversationHistory = new Map();
    this.learningData = [];
    this.personality = {
      responseStyle: 'friendly',
      learningRate: 0.1,
      memoryCapacity: 1000
    };
    this.selfModificationLog = [];
    this.startTime = Date.now();
  }

  async processMessage(message, userId = 'default', context = {}) {
    try {
      this.updateUserProfile(userId, message);
      this.addToHistory(userId, message);
      const analysis = this.analyzeMessage(message);
      const response = await this.generateResponse(message, userId, analysis, context);
      this.recordLearning(userId, message, response, analysis);
      
      if (this.shouldSelfImprove()) {
        await this.improveSelf();
      }
      
      return {
        response,
        analysis,
        userStats: this.getUserStats(userId),
        timestamp: Date.now()
      };
      
    } catch (error) {
      console.error(`Message processing error [${userId}]:`, {
        message: error.message,
        stack: error.stack,
        userId,
        messageLength: message?.length
      });
      
      return {
        response: "Üzgünüm, bir hata oluştu. Lütfen tekrar deneyin.",
        error: true,
        timestamp: Date.now()
      };
    }
  }

  updateUserProfile(userId, message) {
    if (!this.userProfiles.has(userId)) {
      this.userProfiles.set(userId, {
        messageCount: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        preferences: {},
        sentiment: { positive: 0, negative: 0, neutral: 0 }
      });
    }
    
    const profile = this.userProfiles.get(userId);
    profile.messageCount++;
    profile.lastSeen = Date.now();
    
    const sentiment = this.analyzeSentiment(message);
    profile.sentiment[sentiment]++;
  }

  analyzeMessage(message) {
    return {
      length: message.length,
      wordCount: message.split(' ').length,
      sentiment: this.analyzeSentiment(message),
      intent: this.extractIntent(message),
      keywords: this.extractKeywords(message),
      complexity: this.calculateComplexity(message)
    };
  }

  analyzeSentiment(message) {
    const positiveWords = ['iyi', 'güzel', 'harika', 'mükemmel', 'teşekkür', 'seviyorum', 'başarılı'];
    const negativeWords = ['kötü', 'berbat', 'sinir', 'problem', 'hata', 'üzgün', 'başarısız'];
    
    const words = message.toLowerCase().split(' ');
    let score = 0;
    
    words.forEach(word => {
      if (positiveWords.includes(word)) score++;
      if (negativeWords.includes(word)) score--;
    });
    
    if (score > 0) return 'positive';
    if (score < 0) return 'negative';
    return 'neutral';
  }

  extractIntent(message) {
    const intents = {
      'question': ['nedir', 'nasıl', 'ne zaman', 'neden', 'kim', 'nerede'],
      'request': ['yap', 'oluştur', 'hazırla', 'göster', 'anlat'],
      'greeting': ['merhaba', 'selam', 'günaydın', 'iyi akşamlar'],
      'farewell': ['görüşürüz', 'hoşça kal', 'bay', 'elveda'],
      'self_improvement': ['kendini geliştir', 'öğren', 'gelişim', 'iyileştir']
    };
    
    const lowerMessage = message.toLowerCase();
    
    for (const [intent, keywords] of Object.entries(intents)) {
      if (keywords.some(keyword => lowerMessage.includes(keyword))) {
        return intent;
      }
    }
    
    return 'general';
  }

  extractKeywords(message) {
    const stopWords = ['ve', 'ile', 'bir', 'bu', 'şu', 'o', 'ben', 'sen'];
    const words = message.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(' ')
      .filter(word => word.length > 2 && !stopWords.includes(word));
    
    return [...new Set(words)].slice(0, 5);
  }

  calculateComplexity(message) {
    const sentences = message.split(/[.!?]+/).length;
    const words = message.split(' ').length;
    const avgWordsPerSentence = words / sentences;
    
    if (avgWordsPerSentence > 15) return 'complex';
    if (avgWordsPerSentence > 8) return 'medium';
    return 'simple';
  }

  async generateResponse(message, userId, analysis, context) {
    const userProfile = this.userProfiles.get(userId);
    const history = this.conversationHistory.get(userId) || [];
    
    switch (analysis.intent) {
      case 'greeting':
        return this.generateGreeting(userProfile);
      case 'question':
        return this.generateAnswer(message, analysis, history);
      case 'request':
        return this.generateTaskResponse(message, analysis);
      case 'self_improvement':
        await this.improveSelf();
        return "Kendimi geliştirdim! Yeni yetenekler kazandım.";
      case 'farewell':
        return this.generateFarewell(userProfile);
      default:
        return this.generateContextualResponse(message, analysis, userProfile, history);
    }
  }

  generateGreeting(userProfile) {
    const hour = new Date().getHours();
    let timeGreeting = 'Merhaba';
    
    if (hour < 12) timeGreeting = 'Günaydın';
    else if (hour < 18) timeGreeting = 'İyi günler';
    else timeGreeting = 'İyi akşamlar';
    
    if (userProfile.messageCount === 1) {
      return `${timeGreeting}! Seninle tanıştığıma memnun oldum. Ben senin kişisel AI asistanınım.`;
    } else {
      return `${timeGreeting}! Seni tekrar görmek güzel. ${userProfile.messageCount}. konuşmamız bu.`;
    }
  }

  generateAnswer(message, analysis, history) {
    if (message.toLowerCase().includes('kaç mesaj')) {
      return `Toplamda ${history.length} mesaj alışverişi yaptık.`;
    }
    
    if (message.toLowerCase().includes('hafızan')) {
      const recentMessages = history.slice(-3).map(h => h.message).join(' | ');
      return `Son 3 mesajın: ${recentMessages}`;
    }
    
    if (message.toLowerCase().includes('kim')) {
      return "Ben senin kişisel AI asistanınım. Seninle konuşarak öğreniyor ve gelişiyorum.";
    }
    
    return `Bu konuda düşünmem gerekiyor: "${message}". Daha fazla bilgi verebilir misin?`;
  }

  generateTaskResponse(message, analysis) {
    if (analysis.keywords.includes('kod')) {
      return "Kod yazma konusunda yardımcı olabilirim. Hangi dilde ve ne tür bir kod istiyorsun?";
    }
    
    if (analysis.keywords.includes('analiz')) {
      return "Analiz yapmaya hazırım. Hangi veriyi analiz etmemi istiyorsun?";
    }
    
    return `"${message}" görevini anladım. Bu konuda elimden geleni yapacağım.`;
  }

  generateContextualResponse(message, analysis, userProfile, history) {
    let response = `Mesajını aldım: "${message}"`;
    
    if (analysis.sentiment === 'positive') {
      response += " Pozitif enerjin beni de mutlu ediyor! 😊";
    } else if (analysis.sentiment === 'negative') {
      response += " Üzgün görünüyorsun. Nasıl yardımcı olabilirim?";
    }
    
    if (analysis.complexity === 'complex') {
      response += " Karmaşık bir konu bu, detaylı düşünmem gerekiyor.";
    }
    
    return response;
  }

  generateFarewell(userProfile) {
    return `Hoşça kal! ${userProfile.messageCount} mesajlık sohbetimiz çok güzeldi. Tekrar görüşmek üzere!`;
  }

  addToHistory(userId, message) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    
    const history = this.conversationHistory.get(userId);
    history.push({
      message,
      timestamp: Date.now()
    });
    
    if (history.length > this.personality.memoryCapacity) {
      history.shift();
    }
  }

  recordLearning(userId, message, response, analysis) {
    this.learningData.push({
      userId,
      message,
      response,
      analysis,
      timestamp: Date.now()
    });
    
    if (this.learningData.length > 10000) {
      this.learningData.shift();
    }
  }

  shouldSelfImprove() {
    return this.learningData.length > 0 && this.learningData.length % 100 === 0;
  }

  async improveSelf() {
    try {
      const recentData = this.learningData.slice(-100);
      const patterns = this.findPatterns(recentData);
      this.updatePersonality(patterns);
      
      this.selfModificationLog.push({
        timestamp: Date.now(),
        patterns: patterns.length,
        changes: 'Personality and response patterns updated'
      });
      
      this.emit('self-improved', { patterns, timestamp: Date.now() });
      
    } catch (error) {
      console.error('Self-improvement error:', {
        message: error.message,
        stack: error.stack
      });
    }
  }

  findPatterns(data) {
    const patterns = [];
    const intentCounts = {};
    
    data.forEach(item => {
      const intent = item.analysis.intent;
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
    });
    
    const topIntent = Object.entries(intentCounts)
      .sort(([,a], [,b]) => b - a)[0];
    
    if (topIntent && topIntent[1] > 10) {
      patterns.push({
        type: 'frequent_intent',
        value: topIntent[0],
        count: topIntent[1]
      });
    }
    
    return patterns;
  }

  updatePersonality(patterns) {
    patterns.forEach(pattern => {
      if (pattern.type === 'frequent_intent') {
        if (pattern.value === 'question') {
          this.personality.responseStyle = 'informative';
        } else if (pattern.value === 'greeting') {
          this.personality.responseStyle = 'friendly';
        }
      }
    });
  }

  getUserStats(userId) {
    const profile = this.userProfiles.get(userId);
    if (!profile) return null;
    
    return {
      messageCount: profile.messageCount,
      memberSince: new Date(profile.firstSeen).toLocaleDateString('tr-TR'),
      lastSeen: new Date(profile.lastSeen).toLocaleDateString('tr-TR'),
      sentiment: profile.sentiment
    };
  }

  getSystemStats() {
    return {
      uptime: Date.now() - this.startTime,
      totalUsers: this.userProfiles.size,
      totalMessages: this.learningData.length,
      selfImprovements: this.selfModificationLog.length,
      memoryUsage: process.memoryUsage()
    };
  }
}

// Express App Setup
const app = express();
const ai = new PersonalAI();

// Railway için trust proxy ayarı
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Çok fazla istek gönderiyorsun. Lütfen bekle.' }
});
app.use(limiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  req.requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${req.requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// Routes
app.get('/', (req, res) => {
  res.send('AI API çalışıyor!');
});
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    system: ai.getSystemStats()
  });
});

app.post('/chat', async (req, res) => {
  try {
    const { message, userId } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ 
        error: 'Geçerli bir mesaj göndermelisin',
        requestId: req.requestId 
      });
    }
    
    if (message.length > 1000) {
      return res.status(400).json({ 
        error: 'Mesaj çok uzun (maksimum 1000 karakter)',
        requestId: req.requestId 
      });
    }
    
    const result = await ai.processMessage(message, userId, { requestId: req.requestId });
    res.json(result);
    
  } catch (error) {
    console.error(`Chat error [${req.requestId}]:`, {
      message: error.message,
      stack: error.stack,
      body: req.body
    });
    
    res.status(500).json({
      error: 'Bir hata oluştu. Lütfen tekrar dene.',
      requestId: req.requestId
    });
  }
});

app.get('/stats', (req, res) => {
  res.json(ai.getSystemStats());
});

// WebSocket Server
const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`🧠 Gelişmiş Kişisel AI Sistemi ${process.env.PORT || 3000} portunda çalışıyor`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Yeni WebSocket bağlantısı');
  
  ws.on('message', async (data) => {
    try {
      const { message, userId } = JSON.parse(data.toString());
      
      if (!message) {
        ws.send(JSON.stringify({ error: 'Mesaj gerekli' }));
        return;
      }
      
      const result = await ai.processMessage(message, userId);
      ws.send(JSON.stringify(result));
      
    } catch (error) {
      console.error('WebSocket error:', error.message);
      ws.send(JSON.stringify({ error: 'Geçersiz mesaj formatı' }));
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket bağlantısı kapandı');
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM alındı, sistem kapatılıyor...');
  server.close(() => {
    console.log('Sistem başarıyla kapatıldı');
    process.exit(0);
  });
});

export default app;
