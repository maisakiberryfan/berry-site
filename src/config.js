/**
 * @fileoverview Configuration settings for AI Setlist Parser Worker
 */

export const CONFIG = {
  // Berry channel IDs (single source of truth)
  berryChannels: [
    'UC7A7bGRVdIwo93nqnA3x-OQ', // 主頻道
    'UCBOGwPeBtaPRU59j8jshdjQ',
    'UC2cgr_UtYukapRUt404In-A',
  ],
  membershipPlaylistId: 'PLnWT3dUyDsU6hCaYuVsiwsSF8luEilys8',

  // API endpoints
  endpoints: {
    youtubeAPI: 'https://www.googleapis.com/youtube/v3/commentThreads'
  },

  // YouTube CommentThreads API settings
  youtube: {
    maxResults: 100,
    textFormat: 'plainText',
    part: 'snippet',
  },

  // Setlist detection keywords
  setlistKeywords: [
    // Japanese
    'セットリスト', 'セトリ', '歌単', '歌リスト',
    '今日の歌', '本日の歌', '歌った曲',
    
    // English
    'setlist', 'set list', 'playlist', 'song list',
    'today\'s songs', 'songs sung',
    
    // Numeric indicators
    '1.', '2.', '3.', '4.', '5.',
    '１．', '２．', '３．', '４．', '５．',
    
    // Music symbols
    '♪', '🎵', '🎶', '🎤', '🎼'
  ],

  // Comment filtering settings
  commentFilter: {
    minLength: 100,        // Minimum character count
    minLines: 3,           // Minimum line count
    likeWeight: 2,         // Weight for like count in scoring
    lengthWeight: 0.1      // Weight for text length in scoring
  },

  // Response limits
  limits: {
    maxCandidates: 3,      // Max candidates to return in debug
    maxSampleComments: 5   // Max sample comments to return
  },

  // CORS settings
  cors: {
    allowedOrigins: (origin) => {
      const allowed = [
        'https://m-b.win',
        'https://www.m-b.win',
        'http://localhost:8787',
        'http://localhost:8788',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:8787',
        'http://127.0.0.1:8788',
      ]
      if (allowed.includes(origin)) return origin
      // Allow CF Pages preview deployments
      if (origin?.endsWith('.maisakiberry.pages.dev')) return origin
      // Allow all m-b.win subdomains
      if (origin?.endsWith('.m-b.win')) return origin
      // Allow CF Workers dev/staging URL
      if (origin?.endsWith('.workers.dev')) return origin
      // Allow AWS CloudFront URL
      if (origin?.endsWith('.cloudfront.net')) return origin
      return false
    },
    allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Source', 'If-None-Match'],
    exposeHeaders: ['ETag']
  },

  // Comparison mode settings
  comparisonModes: {
    recent: { days: 7 },
    all: {}
  }

}

