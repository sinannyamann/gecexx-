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
    this.memory = new Map(); // Kalıcı hafıza
    this.userProfiles = new Map(); // Kullanıcı profilleri
    this.conversationHistory = new Map(); // Konuşma geçmişi
    this.learningData = []; // Öğrenme verisi
    this.personality = {
      responseStyle: 'friendly',
      learningRate: 0.1,
      memoryCapacity: 1000
    };
    this.selfModificationLog = [];
    this.startTime = Date.now();
  }

  // Gelişmiş mesaj işleme
  async processMessage(message, userId = 'default', context = {}) {
    try {
      // Kullanıcı profili güncelle
      this.updateUserProfile(userId, message);
      
      // Konuşma geçmişine ekle
      this.addToHistory(userId, message);
      
      // Mesaj analizi
      const analysis = this.analyzeMessage(message);
      
      // Yanıt üret
      const response = await this.generateResponse(message, userId, analysis, context);
      
      // Öğrenme verisi kaydet
      this.recordLearning(userId, message, response, analysis);
      
      // Kendini geliştirme kontrolü
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

  // Kullanıcı profili güncelleme
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
    
    // Duygu analizi
    const sentiment = this.analyzeSentiment(message);
    profile.sentiment[sentiment]++;
  }

  // Mesaj analizi
  analyzeMessage(message) {
    const analysis = {
      length: message.length,
      wordCount: message.split(' ').length,
      sentiment: this.analyzeSentiment(message),
      intent: this.extractIntent(message),
      keywords: this.extractKeywords(message),
      complexity: this.calculateComplexity(message)
    };
    
    return analysis;
  }

  // Duygu analizi
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

  // Niyet çıkarma
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

  // Anahtar kelime çıkarma
  extractKeywords(message) {
    const stopWords = ['ve', 'ile', 'bir', 'bu', 'şu', 'o', 'ben', 'sen'];
    const words = message.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(' ')
      .filter(word => word.length > 2 && !stopWords.includes(word));
    
    return [...new Set(words)].slice(0, 5);
  }

  // Karmaşıklık hesaplama
  calculateComplexity(message) {
    const sentences = message.split(/[.!?]+/).length;
    const words = message.split(' ').length;
    const avgWordsPerSentence = words / sentences;
    
    if (avgWordsPerSentence > 15) return 'complex';
    if (avgWordsPerSentence > 8) return 'medium';
    return 'simple';
  }

  // Yanıt üretme
  async generateResponse(message, userId, analysis, context) {
    const userProfile = this.userProfiles.get(userId);
    const history = this.conversationHistory.get(userId) || [];
    
    // Intent'e göre yanıt
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

  // Selamlama üretme
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

  // Soru yanıtlama
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

  // Görev yanıtı
  generateTaskResponse(message, analysis) {
    if (analysis.keywords.includes('kod')) {
      return "Kod yazma konusunda yardımcı olabilirim. Hangi dilde ve ne tür bir kod istiyorsun?";
    }
    
    if (analysis.keywords.includes('analiz')) {
      return "Analiz yapmaya hazırım. Hangi veriyi analiz etmemi istiyorsun?";
    }
    
    return `"${message}" görevini anladım. Bu konuda elimden geleni yapacağım.`;
  }

  // Bağlamsal yanıt
  generateContextualResponse(message, analysis, userProfile, history) {
    let response = `Mesajını aldım: "${message}"`;
    
    // Duygu durumuna göre yanıt ayarla
    if (analysis.sentiment === 'positive') {
      response += " Pozitif enerjin beni de mutlu ediyor! 😊";
    } else if (analysis.sentiment === 'negative') {
      response += " Üzgün görünüyorsun. Nasıl yardımcı olabilirim?";
    }
    
    // Karmaşıklığa göre yanıt
    if (analysis.complexity === 'complex') {
      response += " Karmaşık bir konu bu, detaylı düşünmem gerekiyor.";
    }
    
    return response;
  }

  // Veda
  generateFarewell(userProfile) {
    return `Hoşça kal! ${userProfile.messageCount} mesajlık sohbetimiz çok güzeldi. Tekrar görüşmek üzere!`;
  }

  // Konuşma geçmişine ekleme
  addToHistory(userId, message) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    
    const history = this.conversationHistory.get(userId);
    history.push({
      message,
      timestamp: Date.now()
    });
    
    // Hafıza sınırı
    if (history.length > this.personality.memoryCapacity) {
      history.shift();
    }
  }

  // Öğrenme verisi kaydetme
  recordLearning(userId, message, response, analysis) {
    this.learningData.push({
      userId,
      message,
      response,
      analysis,
      timestamp: Date.now()
    });
    
    // Öğrenme verisi sınırı
    if (this.learningData.length > 10000) {
      this.learningData.shift();
    }
  }

  // Kendini geliştirme kontrolü
  shouldSelfImprove() {
    return this.learningData.length > 0 && this.learningData.length % 100 === 0;
  }

  // Kendini geliştirme
  async improveSelf() {
    try {
      // Son 100 etkileşimi analiz et
      const recentData = this.learningData.slice(-100);
      
      // Pattern'leri bul
      const patterns = this.findPatterns(recentData);
      
      // Kişiliği güncelle
      this.updatePersonality(patterns);
      
      // Log kaydet
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

  // Pattern bulma
  findPatterns(data) {
    const patterns = [];
    const intentCounts = {};
    const sentimentCounts = {};
    
    data.forEach(item => {
      // Intent patterns
      const intent = item.analysis.intent;
      intentCounts[intent] = (intentCounts[intent] || 0) + 1;
      
      // Sentiment patterns
      const sentiment = item.analysis.sentiment;
      sentimentCounts[sentiment] = (sentimentCounts[sentiment] || 0) + 1;
    });
    
    // En sık kullanılan intent
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

  // Kişilik güncelleme
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

  // Kullanıcı istatistikleri
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

  // Sistem istatistikleri
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

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 100, // maksimum 100 istek
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
