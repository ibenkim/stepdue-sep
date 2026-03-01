const { app } = require('@azure/functions');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

// YouTube Data API category IDs → stepdue category
// Full list: https://developers.google.com/youtube/v3/docs/videoCategories
const YOUTUBE_CATEGORY_MAP = {
  '26': 'green',  // How-to & Style
  '27': 'green',  // Education
  '28': 'green',  // Science & Technology
  '25': 'yellow', // News & Politics
  // All other IDs (gaming, entertainment, comedy, etc.) → 'red'
};

const GREEN_KEYWORDS = [
  'tutorial', 'lecture', 'explained', 'how to', 'learn', 'course',
  'university', 'professor', 'calculus', 'chemistry', 'biology',
  'history of', 'programming', 'algorithm', 'math', 'physics',
  'documentation', 'lesson', 'study guide', 'textbook', 'science',
  'engineering', 'medicine', 'anatomy', 'economics', 'linguistics',
  'machine learning', 'data science', 'research', 'analysis',
  'introduction to', 'overview of', 'mit ', 'stanford ', 'harvard ',
  'crash course', 'full course', 'complete guide'
];

const RED_KEYWORDS = [
  'gaming', 'funny', 'fails', 'reaction', 'vlog', 'challenge',
  'meme', 'prank', 'compilation', 'minecraft', 'fortnite',
  'stream highlights', 'unboxing', 'roast', 'best moments',
  'highlights reel', 'entertainment', 'let\'s play', 'gameplay'
];

app.http('classifyPreflight', {
  methods: ['OPTIONS'],
  authLevel: 'anonymous',
  route: 'classify',
  handler: async () => ({ status: 204, headers: CORS_HEADERS })
});

app.http('classify', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'classify',
  handler: async (request) => {
    try {
      const { title, url, domain } = await request.json();
      if (!title || !domain) {
        return { status: 400, headers: CORS_HEADERS, jsonBody: { error: 'title and domain required' } };
      }

      // YouTube: use YouTube Data API v3 for accurate category lookup
      const isYoutube = domain === 'youtube.com' || domain === 'www.youtube.com';
      if (isYoutube && url && process.env.YOUTUBE_API_KEY) {
        let videoId;
        try { videoId = new URL(url).searchParams.get('v'); } catch {}

        if (videoId) {
          const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${process.env.YOUTUBE_API_KEY}`;
          const res = await fetch(apiUrl);
          if (res.ok) {
            const data = await res.json();
            const categoryId = data.items?.[0]?.snippet?.categoryId;
            if (categoryId) {
              const category = YOUTUBE_CATEGORY_MAP[categoryId] || 'red';
              return { headers: CORS_HEADERS, jsonBody: { category, source: 'youtube-api' } };
            }
          }
        }
        // YouTube homepage, Shorts, channel pages — no video ID, no override
        return { headers: CORS_HEADERS, jsonBody: { category: 'red', source: 'domain' } };
      }

      // Keyword matching for all other domains (especially gray/unclassified ones)
      const lower = title.toLowerCase();

      for (const kw of RED_KEYWORDS) {
        if (lower.includes(kw)) {
          return { headers: CORS_HEADERS, jsonBody: { category: 'red', source: 'keyword' } };
        }
      }
      for (const kw of GREEN_KEYWORDS) {
        if (lower.includes(kw)) {
          return { headers: CORS_HEADERS, jsonBody: { category: 'green', source: 'keyword' } };
        }
      }

      return { headers: CORS_HEADERS, jsonBody: { category: 'gray', source: 'none' } };
    } catch (err) {
      return { status: 500, headers: CORS_HEADERS, jsonBody: { error: err.message } };
    }
  }
});
