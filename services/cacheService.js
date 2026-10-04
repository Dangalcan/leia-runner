const { redisClient } = require('../config/redis');

class CacheService {
  constructor() {
    this.sessionPrefix = 'session:';
    this.conversationPrefix = 'session:conversation:';
    this.leiaMetaPrefix = 'leia:meta:';
    this.multiLeiaPrefix = 'multi-leia:';
    this.multiLeiaLockPrefix = 'multi-leia:lock:';
    this.modelsPrefix = 'models:';
    this.validatedModelsKey = 'validated_models';
  }

  /**
   * Parses time frame to milliseconds
   * @param {string} timeFrame - Time frame (e.g., '1h', '2w', '3m', '5d', 'all')
   * @returns {number|null} - Milliseconds from now backwards, null for 'all'
   */
  parseTimeFrame(timeFrame) {
    if (!timeFrame || timeFrame === 'all') {
      return null; // Purge all
    }

    const match = timeFrame.match(/^(\d+)([hdwm])$/);
    if (!match) {
      throw new Error('Invalid time format. Use: Xh (hours), Xd (days), Xw (weeks), Xm (months), or "all"');
    }

    const [, amount, unit] = match;
    const value = parseInt(amount);

    const multipliers = {
      'h': 60 * 60 * 1000,        // hours to milliseconds
      'd': 24 * 60 * 60 * 1000,   // days to milliseconds
      'w': 7 * 24 * 60 * 60 * 1000, // weeks to milliseconds
      'm': 30 * 24 * 60 * 60 * 1000 // months (approx 30 days) to milliseconds
    };

    return value * multipliers[unit];
  }

  /**
   * Parses a specific date to timestamp
   * @param {string} specificDate - Specific date in ISO format (YYYY-MM-DD) or timestamp
   * @returns {number} - Timestamp in milliseconds
   */
  parseSpecificDate(specificDate) {
    if (!specificDate) {
      throw new Error('Specific date required');
    }

    // If it's a numeric timestamp
    if (/^\d+$/.test(specificDate)) {
      const timestamp = parseInt(specificDate);
      // Check if it is a timestamp in seconds or milliseconds
      const isSeconds = timestamp < 10000000000; // timestamp less than year 2001 in ms
      return isSeconds ? timestamp * 1000 : timestamp;
    }

    // If it's an ISO date (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)
    const date = new Date(specificDate);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date format. Use ISO format (YYYY-MM-DD) or timestamp');
    }

    return date.getTime();
  }

  /**
   * Gets all keys matching a pattern
   * @param {string} pattern - Search pattern
   * @returns {Promise<Array>} - Array of keys
   */
  async getKeysByPattern(pattern) {
    try {
      const keys = [];
      const iterator = redisClient.scanIterator({
        MATCH: pattern,
        COUNT: 100
      });

      for await (const key of iterator) {
        keys.push(key);
      }

      return keys;
    } catch (error) {
      console.error('Error scanning keys:', error);
      throw error;
    }
  }

  /**
   * Filters keys by creation date
   * @param {Array} keys - Array of keys to filter
   * @param {number|null} cutoffTime - Cutoff time in milliseconds from epoch, null for no filtering
   * @returns {Promise<Array>} - Array of filtered keys
   */
  async filterKeysByTime(keys, cutoffTime) {
    if (cutoffTime === null) {
      return keys; // Don't filter by time
    }

    const filteredKeys = [];
    
    for (const key of keys) {
      try {
        if (key.startsWith(this.conversationPrefix)) {
          const sessionId = key.replace(this.conversationPrefix, '');
          const sessionCreatedAt = await redisClient.hGet(`${this.sessionPrefix}${sessionId}`, 'createdAt');

          if (sessionCreatedAt) {
            const createdAt = parseInt(sessionCreatedAt);
            if (createdAt && createdAt <= cutoffTime) {
              filteredKeys.push(key);
            }
          }
        } else if (key.startsWith(this.sessionPrefix)) {
          // For sessions, check the createdAt field
          const sessionData = await redisClient.hGet(key, 'createdAt');
          if (sessionData) {
            const createdAt = parseInt(sessionData);
            if (createdAt && createdAt <= cutoffTime) {
              filteredKeys.push(key);
            }
          }
        } else {
          // For other keys, use TTL or assume they should be deleted
          filteredKeys.push(key);
        }
      } catch (error) {
        console.error(`Error checking time for key ${key}:`, error);
        // Skip key on error — cannot determine its age, so don't delete it
      }
    }

    return filteredKeys;
  }

  /**
   * Filters keys by specific session
   * @param {Array} keys - Array of keys to filter
   * @param {string} sessionId - Session ID to filter
   * @returns {Array} - Array of filtered keys
   */
  filterKeysBySession(keys, sessionId) {
    const actorSessionPrefix = `${this.sessionPrefix}${sessionId}:actor:`;
    const actorConversationPrefix = `${this.conversationPrefix}${sessionId}:actor:`;
    return keys.filter(key =>
      key === `${this.sessionPrefix}${sessionId}` ||
      key === `${this.leiaMetaPrefix}${sessionId}` ||
      key === `${this.conversationPrefix}${sessionId}` ||
      key === `${this.multiLeiaPrefix}${sessionId}` ||
      key === `${this.multiLeiaLockPrefix}${sessionId}` ||
      key.startsWith(actorSessionPrefix) ||
      key.startsWith(actorConversationPrefix)
    );
  }

  /**
   * Filters keys by specific model
   * @param {Array} keys - Array of keys to filter
   * @param {string} modelName - Model name to filter
   * @returns {Promise<Array>} - Array of filtered keys
   */
  async filterKeysByModel(keys, modelName) {
    const filteredKeys = [];

    for (const key of keys) {
      try {
        if (key.startsWith(this.sessionPrefix)) {
          const sessionData = await redisClient.hGet(key, 'modelName');
          if (sessionData === modelName) {
            filteredKeys.push(key);
            // Also include associated metadata
            const sessionId = key.replace(this.sessionPrefix, '');
            const metaKey = `${this.leiaMetaPrefix}${sessionId}`;
            if (keys.includes(metaKey)) {
              filteredKeys.push(metaKey);
            }

            const conversationKey = `${this.conversationPrefix}${sessionId}`;
            if (keys.includes(conversationKey)) {
              filteredKeys.push(conversationKey);
            }
          }
        } else if (key.startsWith(this.modelsPrefix)) {
          // Include related model keys
          filteredKeys.push(key);
        }
      } catch (error) {
        console.error(`Error checking model for key ${key}:`, error);
      }
    }

    return filteredKeys;
  }

  /**
   * Filters keys by specific metadata
   * @param {Array} keys - Array of keys to filter
   * @param {Object} metadata - Object with metadata to search for
   * @returns {Promise<Array>} - Array of filtered keys
   */
  async filterKeysByMetadata(keys, metadata) {
    const filteredKeys = [];

    for (const key of keys) {
      try {
        if (key.startsWith(this.leiaMetaPrefix)) {
          const storedMetadata = await redisClient.hGetAll(key);
          
          // Check if all filter fields match
          let matches = true;
          for (const [field, value] of Object.entries(metadata)) {
            if (storedMetadata[field] !== String(value)) {
              matches = false;
              break;
            }
          }

          if (matches) {
            filteredKeys.push(key);
            // Also include associated session
            const sessionId = key.replace(this.leiaMetaPrefix, '');
            const sessionKey = `${this.sessionPrefix}${sessionId}`;
            if (keys.includes(sessionKey)) {
              filteredKeys.push(sessionKey);
            }
          }
        }
      } catch (error) {
        console.error(`Error checking metadata for key ${key}:`, error);
      }
    }

    return filteredKeys;
  }

  /**
   * Purges cache based on specific criteria
   * @param {Object} options - Purge options
   * @param {string} options.f - Time frame ('1h', '2d', '1w', '3m', 'all')
   * @param {string} options.date - Specific date (YYYY-MM-DD or timestamp) - purge before this date
   * @param {string} options.sessionId - Specific session ID (optional)
   * @param {string} options.provider - Specific model name (optional)
   * @param {Object} options.metadata - Specific metadata to filter (optional)
   * @returns {Promise<Object>} - Purge result
   */
  async purgeCache(options = {}) {
    try {
      const { f = 'all', date, sessionId, provider, metadata } = options;
      
      let cutoffTime = null;

      // Parse time frame or specific date
      if (date) {
        cutoffTime = this.parseSpecificDate(date);
        console.log(`Using specific date: ${new Date(cutoffTime).toISOString()}`);
      } else if (f !== 'all') {
        const timeFrameMs = this.parseTimeFrame(f);
        cutoffTime = timeFrameMs ? Date.now() - timeFrameMs : null;
        console.log(`Using time frame: ${f} (cutoff: ${cutoffTime ? new Date(cutoffTime).toISOString() : 'none'})`);
      }

      // Get all relevant keys
      const patterns = [
        `${this.sessionPrefix}*`,
        `${this.conversationPrefix}*`,
        `${this.leiaMetaPrefix}*`,
        `${this.multiLeiaPrefix}*`,
        `${this.modelsPrefix}*`,
        this.validatedModelsKey
      ];

      let allKeys = [];
      for (const pattern of patterns) {
        const keys = await this.getKeysByPattern(pattern);
        allKeys = allKeys.concat(keys);
      }

      allKeys = [...new Set(allKeys)];
      console.log(`Found ${allKeys.length} keys in total`);

      // Apply filters sequentially
      let keysToDelete = allKeys;

      // Filter by time if specified (f or date)
      if (cutoffTime !== null) {
        keysToDelete = await this.filterKeysByTime(keysToDelete, cutoffTime);
        console.log(`After time filter: ${keysToDelete.length} keys`);
      }

      // Filter by session if specified
      if (sessionId) {
        keysToDelete = this.filterKeysBySession(keysToDelete, sessionId);
        console.log(`After session filter: ${keysToDelete.length} keys`);
      }

      // Filter by model if specified
      if (provider) {
        keysToDelete = await this.filterKeysByModel(keysToDelete, provider);
        console.log(`After model filter: ${keysToDelete.length} keys`);
      }

      // Filter by metadata if specified
      if (metadata && Object.keys(metadata).length > 0) {
        keysToDelete = await this.filterKeysByMetadata(keysToDelete, metadata);
        console.log(`After metadata filter: ${keysToDelete.length} keys`);
      }

      // Delete selected keys
      let deletedCount = 0;
      if (keysToDelete.length > 0) {
        // Delete in batches to avoid memory issues
        const batchSize = 100;
        for (let i = 0; i < keysToDelete.length; i += batchSize) {
          const batch = keysToDelete.slice(i, i + batchSize);
          const result = await redisClient.del(batch);
          deletedCount += result;
        }
      }

      const result = {
        success: true,
        deletedKeys: deletedCount,
        totalKeysFound: allKeys.length,
        timeFrame: date ? null : f,
        specificDate: date || null,
        appliedFilters: {
          sessionId: sessionId || null,
          provider: provider || null,
          metadata: metadata || null
        }
      };

      console.log('Cache purge completed:', result);
      return result;

    } catch (error) {
      console.error('Error purging cache:', error);
      return {
        success: false,
        error: error.message,
        deletedKeys: 0
      };
    }
  }

  /**
   * Gets cache statistics
   * @returns {Promise<Object>} - Cache statistics
   */
  async getCacheStats() {
    try {
      const patterns = [
        { name: 'sessions', pattern: `${this.sessionPrefix}*` },
        { name: 'conversations', pattern: `${this.conversationPrefix}*` },
        { name: 'metadata', pattern: `${this.leiaMetaPrefix}*` },
        { name: 'multiLeia', pattern: `${this.multiLeiaPrefix}*` },
        { name: 'models', pattern: `${this.modelsPrefix}*` }
      ];

      const stats = {
        total: 0,
        breakdown: {}
      };

      for (const { name, pattern } of patterns) {
        let keys = await this.getKeysByPattern(pattern);

        if (name === 'sessions') {
          keys = keys.filter(key => !key.startsWith(this.conversationPrefix));
        }

        if (name === 'conversations') {
          keys = keys.filter(key => key.startsWith(this.conversationPrefix));
        }

        stats.breakdown[name] = keys.length;
        stats.total += keys.length;
      }

      // Include validated models keys
      const validatedModelsExists = await redisClient.exists(this.validatedModelsKey);
      if (validatedModelsExists) {
        stats.breakdown.validatedModels = 1;
        stats.total += 1;
      }

      return stats;
    } catch (error) {
      console.error('Error getting cache statistics:', error);
      throw error;
    }
  }
}

module.exports = new CacheService();
